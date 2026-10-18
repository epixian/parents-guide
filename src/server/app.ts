import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import type { ApiError, SearchResult } from "../shared/types.js";
import { acceptsBrotli, BrotliCache } from "./brotliCache.js";
import { BrowseQueryError, parseBrowseQuery } from "../shared/browse.js";
import { searchOpenLibrary } from "./catalog/openlibrary.js";
import { searchTmdb } from "./catalog/tmdb.js";
import { config } from "./config.js";
import { HttpError } from "./http.js";
import type { ReportService } from "./reports.js";
import type { SearchCache } from "./searchCache.js";
import type { SimilarService } from "./similar.js";
import { serviceIds, type WatchService } from "./watchProviders.js";

/**
 * The visitor's address, for the AI limit and trending. Behind nginx, use
 * X-Real-IP: nginx sets it to the connecting address, so a client cannot
 * change it. Never the first X-Forwarded-For entry: nginx appends to whatever
 * the client sent, so that entry can be any value. The last entry is the one
 * that nginx added.
 */
export function clientAddress(
  header: (name: string) => string | undefined,
  remote: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const real = header("x-real-ip")?.trim();
    if (real) return real;
    const forwarded = header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return remote ?? "unknown";
}

function clientKey(c: Context): string {
  return clientAddress((name) => c.req.header(name), getConnInfo(c).remote.address, config.trustProxy);
}

export function createApi(
  reports: ReportService,
  searchCache: SearchCache,
  watch: WatchService,
  similar: SimilarService,
  titlesBrotli = new BrotliCache(),
): Hono {
  const api = new Hono();
  /** The title list as JSON text for one version, so each version is converted only once. */
  let titlesJson: { tag: string; text: string } | null = null;

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

  api.get("/recent", async (c) => c.json(await reports.getRecent(12)));

  api.get("/trending", async (c) => c.json(await reports.getTrending(12)));

  // Every saved title in one list. The browser filters it with src/shared/browse.ts.
  // "no-cache" with an ETag: the browser keeps its copy and asks again on each
  // use, and the answer is an empty 304 until a title is added or changed.
  // Browsers that accept Brotli get a copy compressed once per version (see
  // BrotliCache). That copy has its own ETag ("-br"), as each content coding
  // must; either ETag of the current version gets a 304.
  api.get("/titles", async (c) => {
    const { tag, titles } = await reports.titles();
    const plainTag = `W/"${tag}"`;
    const brTag = `W/"${tag}-br"`;
    c.header("Cache-Control", "no-cache");
    c.header("Vary", "Accept-Encoding");
    const known = c.req.header("if-none-match")?.split(",").map((t) => t.trim()) ?? [];
    const match = known.find((t) => t === plainTag || t === brTag);
    if (match) {
      c.header("ETag", match);
      return c.body(null, 304);
    }
    if (titlesJson?.tag !== tag) titlesJson = { tag, text: JSON.stringify(titles) };
    const text = titlesJson.text;
    c.header("Content-Type", "application/json; charset=UTF-8");
    const br = acceptsBrotli(c.req.header("accept-encoding")) ? titlesBrotli.get(tag, () => text) : null;
    if (br) {
      c.header("ETag", brTag);
      c.header("Content-Encoding", "br");
      // A view of the same memory, not a copy. zlib output is never a SharedArrayBuffer.
      return c.body(new Uint8Array(br.buffer as ArrayBuffer, br.byteOffset, br.byteLength));
    }
    c.header("ETag", plainTag);
    return c.body(text);
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

  // Streaming services for a title, and every service for the "My services" choices.
  // The server keeps each answer for one day (see WatchService).
  api.get("/watch/:id", async (c) => {
    const id = c.req.param("id");
    const res = await watch.title(id);
    reports.setProviders(id, serviceIds(res.providers));
    return c.json(res);
  });

  api.get("/providers", async (c) => c.json(await watch.catalog()));

  // Every rated title that TMDB recommends for a movie or TV series, best first.
  // The browser orders them by the user's thumbs up and shows the first few.
  api.get("/similar/:id", async (c) => c.json(await reports.items(await similar.title(c.req.param("id")))));

  api.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json<ApiError>({ error: err.message }, err.status);
    if (err instanceof BrowseQueryError) return c.json<ApiError>({ error: err.message }, 400);
    console.error(err);
    return c.json<ApiError>({ error: "Internal error" }, 500);
  });

  return api;
}
