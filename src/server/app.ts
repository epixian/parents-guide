import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ApiError, SearchResult } from "../shared/types.js";
import { searchOpenLibrary } from "./catalog/openlibrary.js";
import { searchTmdb } from "./catalog/tmdb.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";
import type { ReportService } from "./reports.js";

function clientKey(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

export function createApi(reports: ReportService): Hono {
  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true }));

  api.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2 || q.length > 200) throw new HttpError(400, "Query must be 2-200 characters");

    // One catalog failing (e.g. no TMDB key) should not hide the other's results.
    const [screen, books] = await Promise.allSettled([searchTmdb(q), searchOpenLibrary(q)]);
    const results: SearchResult[] = [];
    const warnings: string[] = [];
    if (screen.status === "fulfilled") results.push(...screen.value.slice(0, 10));
    else warnings.push(`Movies/TV search failed: ${(screen.reason as Error).message}`);
    if (books.status === "fulfilled") results.push(...books.value.slice(0, 8));
    else warnings.push(`Book search failed: ${(books.reason as Error).message}`);
    if (!results.length && warnings.length === 2) throw new HttpError(502, warnings.join(" "));
    return c.json({ results, warnings });
  });

  api.get("/recent", async (c) => c.json(await reports.getRecent(8)));

  api.get("/trending", async (c) => c.json(await reports.getTrending(8)));

  api.get("/report/:id", async (c) => {
    const id = c.req.param("id");
    const res = await reports.getReport(id, clientKey(c));
    if (res.status === "ok") reports.recordView(id, clientKey(c));
    return c.json(res);
  });

  api.get("/tv/:tmdbId", async (c) => {
    const series = await reports.getSeries(c.req.param("tmdbId"));
    reports.recordView(series.id, clientKey(c));
    return c.json(series);
  });

  api.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json<ApiError>({ error: err.message }, err.status);
    console.error(err);
    return c.json<ApiError>({ error: "Internal error" }, 500);
  });

  return api;
}
