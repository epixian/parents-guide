import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi } from "./app.js";
import { FileReportCache } from "./cache.js";
import { config } from "./config.js";
import { Popularity } from "./popularity.js";
import { RateLimiter } from "./rateLimit.js";
import { ReportService } from "./reports.js";

fs.mkdirSync(config.cacheDir, { recursive: true });

const limiter = new RateLimiter(config.aiLookupsPerIpPerHour, 60 * 60 * 1000);
setInterval(() => limiter.sweep(), 10 * 60 * 1000).unref();

const popularity = new Popularity(path.join(config.cacheDir, "popularity.json"));
await popularity.load();

const reports = new ReportService(new FileReportCache(config.cacheDir), limiter, popularity);
void reports.loadIndex();

// Save pending view counts when Supervisor (or Ctrl+C) stops the server.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void popularity.flush().finally(() => process.exit(0));
  });
}

const app = new Hono();
app.route("/api", createApi(reports));

// Production: serve the built client. In development, Vite serves it instead.
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), clientDir) }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`API listening on http://${config.host}:${info.port}`);
  console.log(`Cache directory: ${config.cacheDir}`);
  if (!config.anthropicApiKey) console.warn("ANTHROPIC_API_KEY is not set: new AI lookups will fail.");
  if (!config.tmdbApiKey) console.warn("TMDB_API_KEY is not set: movie and TV search will fail.");
});
