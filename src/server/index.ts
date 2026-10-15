import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApi } from "./app.js";
import { FileReportCache } from "./cache.js";
import { config } from "./config.js";
import { RateLimiter } from "./rateLimit.js";
import { ReportService } from "./reports.js";

fs.mkdirSync(config.cacheDir, { recursive: true });

const limiter = new RateLimiter(config.aiLookupsPerIpPerHour, 60 * 60 * 1000);
setInterval(() => limiter.sweep(), 10 * 60 * 1000).unref();

const reports = new ReportService(new FileReportCache(config.cacheDir), limiter);
void reports.loadIndex();

const app = new Hono();
app.route("/api", createApi(reports));

// Production: serve the built client. In development, Vite serves it instead.
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), clientDir) }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  console.log(`Cache directory: ${config.cacheDir}`);
  if (!config.anthropicApiKey) console.warn("ANTHROPIC_API_KEY is not set: new AI lookups will fail.");
  if (!config.tmdbApiKey) console.warn("TMDB_API_KEY is not set: movie and TV search will fail.");
});
