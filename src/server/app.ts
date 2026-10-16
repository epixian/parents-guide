import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ApiError, SearchResult } from "../shared/types.js";
import { BrowseQueryError, parseBrowseQuery } from "../shared/browse.js";
import { searchOpenLibrary } from "./catalog/openlibrary.js";
import { searchTmdb } from "./catalog/tmdb.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";
import type { ReportService } from "./reports.js";
import type { SearchCache } from "./searchCache.js";

function clientKey(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

export function createApi(reports: ReportService, searchCache: SearchCache): Hono {
  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true }));

  api.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2 || q.length > 200) throw new HttpError(400, "Query must be 2-200 characters");
    const cached = await searchCache.get(q);
    if (cached) return c.json(cached);

    // One catalog failing (e.g. no TMDB key) should not hide the other's results.
    const [screen, books] = await Promise.allSettled([searchTmdb(q), searchOpenLibrary(q)]);
    const results: SearchResult[] = [];
    const warnings: string[] = [];
    if (screen.status === "fulfilled") results.push(...screen.value.slice(0, 10));
    else warnings.push(`Movies/TV search failed: ${(screen.reason as Error).message}`);
    if (books.status === "fulfilled") results.push(...books.value.slice(0, 8));
    else warnings.push(`Book search failed: ${(books.reason as Error).message}`);
    if (!results.length && warnings.length === 2) throw new HttpError(502, warnings.join(" "));
    // Cache complete answers only, so a catalog outage is not remembered.
    if (!warnings.length) await searchCache.set(q, { results, warnings });
    return c.json({ results, warnings });
  });

  // Rated titles only: instant, and every suggestion opens a page that already exists.
  api.get("/suggest", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2 || q.length > 200) throw new HttpError(400, "Query must be 2-200 characters");
    return c.json(await reports.suggest(q, 8));
  });

  api.get("/recent", async (c) => c.json(await reports.getRecent(8)));

  api.get("/trending", async (c) => c.json(await reports.getTrending(8)));

  // Every saved title in one list. The browser filters it with src/shared/browse.ts.
  // "no-cache" with an ETag: the browser keeps its copy and asks again on each
  // use, and the answer is an empty 304 until a title is added or changed.
  api.get("/titles", async (c) => {
    const { tag, titles } = await reports.titles();
    const etag = `W/"${tag}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "no-cache");
    if (c.req.header("if-none-match")?.split(",").some((t) => t.trim() === etag)) return c.body(null, 304);
    return c.json(titles);
  });

  // Browse and suggest on the server: the fallback when the browser asks to save data.
  api.get("/browse", async (c) => {
    const filters = parseBrowseQuery(new URL(c.req.url).searchParams);
    return c.json(await reports.browse(filters));
  });

  api.get("/report/:id", async (c) => {
    const id = c.req.param("id");
    const res = await reports.getReport(id, clientKey(c));
    if (res.status === "ok") reports.recordView(id, clientKey(c));
    return c.json(res);
  });

  api.get("/mood/:id", async (c) => c.json(await reports.getMood(c.req.param("id"))));

  api.get("/tv/:tmdbId", async (c) => {
    const series = await reports.getSeries(c.req.param("tmdbId"));
    reports.recordView(series.id, clientKey(c));
    return c.json(series);
  });

  api.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json<ApiError>({ error: err.message }, err.status);
    if (err instanceof BrowseQueryError) return c.json<ApiError>({ error: err.message }, 400);
    console.error(err);
    return c.json<ApiError>({ error: "Internal error" }, 500);
  });

  return api;
}
