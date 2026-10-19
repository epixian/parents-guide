import { test } from "node:test";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { clientAddress, createApi } from "../src/server/app.js";
import { acceptsBrotli, BrotliCache } from "../src/server/brotliCache.js";
import type { CatalogIndex } from "../src/server/catalogIndex.js";
import type { ReportService } from "../src/server/reports.js";
import type { SearchCache } from "../src/server/searchCache.js";
import type { SimilarService } from "../src/server/similar.js";
import type { WatchService } from "../src/server/watchProviders.js";
import type { IndexEntry } from "../src/shared/types.js";

const TITLE: IndexEntry = {
  id: "tmdb-movie-603",
  kind: "movie",
  title: "The Matrix",
  years: "1999",
  imageUrl: null,
  addedAt: "2026-10-01T00:00:00Z",
  ratedParts: 1,
  themeTags: [],
  scores: {},
  treatments: {},
};

function apiWith(tag: { value: string }, brotli = new BrotliCache()) {
  const reports = {
    titles: async () => ({ tag: tag.value, titles: [TITLE] }),
    browse: async () => ({ total: 0, offset: 0, items: [], tags: [] }),
  } as unknown as ReportService;
  return createApi(reports, {} as SearchCache, {} as WatchService, {} as SimilarService, null, brotli);
}

test("GET /titles sends the list with an ETag, then 304 until the list changes", async () => {
  const tag = { value: "a-1" };
  const api = apiWith(tag);
  const first = await api.request("/titles");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  const etag = first.headers.get("etag")!;
  assert.equal(etag, 'W/"a-1"');
  assert.deepEqual(await first.json(), [TITLE]);

  const same = await api.request("/titles", { headers: { "if-none-match": etag } });
  assert.equal(same.status, 304);

  tag.value = "a-2";
  const changed = await api.request("/titles", { headers: { "if-none-match": etag } });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("etag"), 'W/"a-2"');
});

test("GET /browse answers 400 for a bad filter value", async () => {
  const res = await apiWith({ value: "x" }).request("/browse?kind=game");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /kind/);
});

test("GET /titles sends plain JSON until the Brotli copy is ready, then Brotli", async () => {
  const brotli = new BrotliCache();
  const api = apiWith({ value: "b-1" }, brotli);
  const headers = { "accept-encoding": "gzip, br" };
  const first = await api.request("/titles", { headers });
  assert.equal(first.headers.get("content-encoding"), null);
  assert.equal(first.headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(await first.json(), [TITLE]);

  await brotli.idle();
  const res = await api.request("/titles", { headers });
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(res.headers.get("etag"), 'W/"b-1-br"');
  assert.match(res.headers.get("content-type")!, /application\/json/);
  const body = zlib.brotliDecompressSync(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(JSON.parse(body.toString()), [TITLE]);

  const gzipOnly = await api.request("/titles", { headers: { "accept-encoding": "gzip" } });
  assert.equal(gzipOnly.headers.get("content-encoding"), null);
  assert.equal(gzipOnly.headers.get("etag"), 'W/"b-1"');

  // Either ETag of the current version gets a 304, with that ETag.
  const again = await api.request("/titles", { headers: { ...headers, "if-none-match": 'W/"b-1-br"' } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), 'W/"b-1-br"');
});

test("acceptsBrotli reads Accept-Encoding", () => {
  assert.equal(acceptsBrotli("gzip, deflate, br, zstd"), true);
  assert.equal(acceptsBrotli("BR;q=0.5"), true);
  assert.equal(acceptsBrotli("br;q=0, gzip"), false);
  assert.equal(acceptsBrotli("gzip"), false);
  assert.equal(acceptsBrotli("brotli"), false);
  assert.equal(acceptsBrotli(undefined), false);
});

test("clientAddress cannot be set by the client behind nginx", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];
  // nginx: X-Real-IP $remote_addr; X-Forwarded-For $proxy_add_x_forwarded_for (client value, then the real address).
  const spoofed = headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
  assert.equal(clientAddress(spoofed, "127.0.0.1", true), "203.0.113.7");
  assert.equal(clientAddress(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), "127.0.0.1", true), "203.0.113.7");
  assert.equal(clientAddress(headers({}), "127.0.0.1", true), "127.0.0.1");
  // Without a trusted proxy, headers are ignored.
  assert.equal(clientAddress(spoofed, "198.51.100.2", false), "198.51.100.2");
  assert.equal(clientAddress(headers({}), undefined, false), "unknown");
});

test("GET /similar/:id answers with the rated titles only, in TMDB's order", async () => {
  const rated = new Set(["tmdb-movie-1", "tmdb-movie-3", ...Array.from({ length: 20 }, (_, i) => `tmdb-movie-${100 + i}`)]);
  const reports = {
    items: async (ids: string[]) => ids.filter((id) => rated.has(id)).map((id) => ({ ...TITLE, id })),
  } as unknown as ReportService;
  const similar = {
    title: async () => ["tmdb-movie-3", "tmdb-movie-2", "tmdb-movie-1", ...Array.from({ length: 20 }, (_, i) => `tmdb-movie-${100 + i}`)],
  } as unknown as SimilarService;
  const api = createApi(reports, {} as SearchCache, {} as WatchService, similar);
  const res = await api.request("/similar/tmdb-movie-329");
  const ids = ((await res.json()) as IndexEntry[]).map((t) => t.id);
  assert.equal(ids.length, 22);
  assert.deepEqual(ids.slice(0, 3), ["tmdb-movie-3", "tmdb-movie-1", "tmdb-movie-100"]);
});

test("GET /catalog sends the list with an ETag, and an empty list before the first build", async () => {
  const reports = {} as ReportService;
  let list: { tag: string; text: string } | null = null;
  const catalog = { response: () => list } as unknown as CatalogIndex;
  const api = createApi(reports, {} as SearchCache, {} as WatchService, {} as SimilarService, catalog);
  const empty = await api.request("/catalog");
  assert.deepEqual(await empty.json(), { movie: [], tv: [] });
  assert.equal(empty.headers.get("etag"), null);

  list = { tag: "123", text: '{"movie":[[603,"The Matrix",1999]],"tv":[]}' };
  const first = await api.request("/catalog");
  assert.equal(first.headers.get("etag"), 'W/"123"');
  assert.deepEqual(await first.json(), { movie: [[603, "The Matrix", 1999]], tv: [] });
  const again = await api.request("/catalog", { headers: { "if-none-match": 'W/"123"' } });
  assert.equal(again.status, 304);
});

test("GET /suggest passes the catalog titles to the search", async () => {
  const titles = [{ id: "tmdb-movie-603", kind: "movie", title: "The Matrix", year: 1999 }];
  let passed: unknown = null;
  const reports = {
    suggest: async (_q: string, _limit: number, catalog: unknown) => ((passed = catalog), []),
  } as unknown as ReportService;
  const catalog = { titles: () => titles } as unknown as CatalogIndex;
  const api = createApi(reports, {} as SearchCache, {} as WatchService, {} as SimilarService, catalog);
  assert.equal((await api.request("/suggest?q=matrix")).status, 200);
  assert.equal(passed, titles);
});
