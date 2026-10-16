import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../src/server/app.js";
import type { ReportService } from "../src/server/reports.js";
import type { SearchCache } from "../src/server/searchCache.js";
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

function apiWith(tag: { value: string }) {
  const reports = {
    titles: async () => ({ tag: tag.value, titles: [TITLE] }),
    browse: async () => ({ total: 0, offset: 0, items: [], tags: [] }),
  } as unknown as ReportService;
  return createApi(reports, {} as SearchCache);
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
