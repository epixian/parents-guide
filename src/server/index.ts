import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi } from "./app.js";
import { backup } from "./backup.js";
import { FileReportCache } from "./cache.js";
import { CatalogIndex } from "./catalogIndex.js";
import { config } from "./config.js";
import { DailyLimit } from "./dailyLimit.js";
import { createPages } from "./pages.js";
import { Popularity } from "./popularity.js";
import { RateLimiter } from "./rateLimit.js";
import { ReportService } from "./reports.js";
import { SearchCache } from "./searchCache.js";
import { SimilarService } from "./similar.js";
import { TitleChangeLog } from "./titleChanges.js";
import { WatchService } from "./watchProviders.js";

fs.mkdirSync(config.cacheDir, { recursive: true });

const limiter = new RateLimiter(config.aiLookupsPerIpPerHour, 60 * 60 * 1000);
setInterval(() => limiter.sweep(), 10 * 60 * 1000).unref();

const daily = new DailyLimit(config.aiLookupsPerDay);
await daily.load(path.join(config.cacheDir, "usage.jsonl"));

const popularity = new Popularity(path.join(config.cacheDir, "popularity.json"));
await popularity.load();

const watch = new WatchService(config.cacheDir);
// When each title last changed, so browsers load only the changes, also after a restart.
const changeLog = new TitleChangeLog(path.join(config.cacheDir, "title-changes.json"));

const reports = new ReportService(
  new FileReportCache(config.cacheDir, (rel) => backup?.queue(rel)),
  limiter,
  popularity,
  changeLog,
  // The saved streaming services at any age, with no TMDB request (maxFetches 0).
  async (ids, save) => void (await watch.sweep(ids, save, { maxFetches: 0 })),
  daily,
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
    void Promise.all([popularity.flush(), changeLog.flush()])
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

// Streaming answers are refetched after one day; files are deleted after a week.
setInterval(() => void watch.prune(), 60 * 60 * 1000).unref();
void watch.prune();

// Streaming services of every rated movie and TV series, for the Browse filter
// "On my services". At startup, then every hour. Each sweep asks TMDB again only
// for titles with no file or one older than a day, and makes at most
// SWEEP_MAX_FETCHES requests; the rest wait for a later sweep. 300 an hour is
// 7,200 a day, well above the about 2,150 titles that need one each day.
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP_MAX_FETCHES = 300;
let sweeping = false;
async function sweepStreaming(): Promise<void> {
  if (sweeping || !config.tmdbApiKey) return;
  sweeping = true;
  try {
    const ids = await reports.screenIds();
    const save = (id: string, providers: number[]) => reports.setProviders(id, providers);
    const { fetched, failed, stale } = await watch.sweep(ids, save, { maxFetches: SWEEP_MAX_FETCHES });
    console.log(
      `Streaming sweep: ${ids.length} titles, ${fetched} from TMDB${failed ? `, ${failed} failed` : ""}${stale ? `, ${stale} left for later` : ""}`,
    );
  } catch (err) {
    console.warn(`Streaming sweep failed: ${(err as Error).message}`);
  } finally {
    sweeping = false;
  }
}
setInterval(() => void sweepStreaming(), SWEEP_EVERY_MS).unref();
void sweepStreaming();

const similar = new SimilarService(config.cacheDir);
setInterval(() => void similar.prune(), 60 * 60 * 1000).unref();
void similar.prune();

// Popular TMDB titles for search suggestions. Rebuilt when older than a week
// (about 550 TMDB requests, 3 minutes); checked at startup, then once a day.
const catalog = new CatalogIndex(config.cacheDir);
await catalog.load();
if (config.tmdbApiKey) {
  setInterval(() => void catalog.refresh(), 24 * 60 * 60 * 1000).unref();
  void catalog.refresh();
}

app.route("/api", createApi(reports, searchCache, watch, similar, catalog));

// Production: serve the built client. In development, Vite serves it instead.
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  // The app's pages (/, /r/..., /browse, ...) and robots.txt and sitemap.xml, before the static files.
  const shell = fs.readFileSync(path.join(clientDir, "index.html"), "utf8");
  app.route("/", createPages(reports, shell, config.siteUrl));
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
  if (backup?.on && config.s3) console.log(`Backup: s3://${config.s3.bucket}/${config.s3.prefix}`);
  else console.log(process.env.S3_BUCKET ? "Backup: off (see the warning above)" : "Backup: off (S3_BUCKET not set)");
});
