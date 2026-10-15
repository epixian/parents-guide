import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi } from "./app.js";
import { backup } from "./backup.js";
import { FileReportCache } from "./cache.js";
import { config } from "./config.js";
import { Popularity } from "./popularity.js";
import { RateLimiter } from "./rateLimit.js";
import { ReportService } from "./reports.js";
import { SearchCache } from "./searchCache.js";
import { SimilarService } from "./similar.js";
import { WatchService } from "./watchProviders.js";

fs.mkdirSync(config.cacheDir, { recursive: true });

const limiter = new RateLimiter(config.aiLookupsPerIpPerHour, 60 * 60 * 1000);
setInterval(() => limiter.sweep(), 10 * 60 * 1000).unref();

const popularity = new Popularity(path.join(config.cacheDir, "popularity.json"));
await popularity.load();

const reports = new ReportService(
  new FileReportCache(config.cacheDir, (rel) => backup?.queue(rel)),
  limiter,
  popularity,
);

// The view counts and the usage log change often; copy them off-site every 10 minutes if changed.
const LOG_FILES = ["popularity.json", "usage.jsonl"];
const uploadedMtime = new Map<string, number>();
function backupLogs(): void {
  for (const rel of LOG_FILES) {
    const mtime = fs.statSync(path.join(config.cacheDir, rel), { throwIfNoEntry: false })?.mtimeMs;
    if (mtime && mtime !== uploadedMtime.get(rel)) {
      uploadedMtime.set(rel, mtime);
      backup?.queue(rel);
    }
  }
}
if (backup) setInterval(backupLogs, 10 * 60 * 1000).unref();
void reports.loadIndex();

// Save pending view counts when Supervisor (or Ctrl+C) stops the server.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void popularity
      .flush()
      .then(() => {
        backupLogs();
        return backup?.flush(10_000);
      })
      .finally(() => process.exit(0));
  });
}

const app = new Hono();
const searchCache = new SearchCache(config.cacheDir);
// Delete expired search answers once an hour, so the folder holds about six hours of searches.
setInterval(() => void searchCache.prune(), 60 * 60 * 1000).unref();
void searchCache.prune();

const watch = new WatchService(config.cacheDir);
// Streaming answers are refetched after one day; files are deleted after a week.
setInterval(() => void watch.prune(), 60 * 60 * 1000).unref();
void watch.prune();

const similar = new SimilarService(config.cacheDir);
setInterval(() => void similar.prune(), 60 * 60 * 1000).unref();
void similar.prune();

app.route("/api", createApi(reports, searchCache, watch, similar));

// Production: serve the built client. In development, Vite serves it instead.
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  app.use(
    "/*",
    serveStatic({
      root: path.relative(process.cwd(), clientDir),
      onFound: (filePath, c) => {
        // Vite puts a content hash in every file name under assets/, and the
        // font file never changes, so browsers can keep these for a year.
        // Other files (index.html, favicon) must be checked again on each visit.
        const immutable = /[\\/](assets|fonts)[\\/]/.test(filePath);
        c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`API listening on http://${config.host}:${info.port}`);
  console.log(`Cache directory: ${config.cacheDir}`);
  if (!config.anthropicApiKey) console.warn("ANTHROPIC_API_KEY is not set: new AI lookups will fail.");
  if (!config.tmdbApiKey) console.warn("TMDB_API_KEY is not set: movie and TV search will fail.");
  console.log(config.s3 ? `Backup: s3://${config.s3.bucket}/${config.s3.prefix}` : "Backup: off (S3_BUCKET not set)");
});
