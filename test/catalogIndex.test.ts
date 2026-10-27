import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CatalogIndex } from "../src/server/catalogIndex.js";
import { catalogEntries } from "../src/shared/browse.js";

const DAY = 24 * 60 * 60 * 1000;

/** The titles the browser gets from the index's response. */
function titles(index: CatalogIndex) {
  const res = index.response();
  return res ? catalogEntries(JSON.parse(res.text)) : [];
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "catalog-"));
}

/** A fake TMDB with 2 pages per kind and sort order; "popular" repeats one "votes" title. */
function fakeTmdb(calls: string[] = []) {
  return async (kind: "movie" | "tv", sort: "votes" | "popular", page: number, today: string) => {
    calls.push(`${kind} ${sort} ${page} ${today}`);
    if (page > 2) return [];
    const kindBase = kind === "movie" ? 10_000 : 20_000;
    const base = kindBase + (sort === "votes" ? 0 : 1000) + page * 100;
    const items = Array.from({ length: 20 }, (_, i) => ({ id: base + i, title: `${kind} ${base + i}`, year: 2000 }));
    if (sort === "popular" && page === 1) items[0] = { id: kindBase + 100, title: "dup", year: 2000 };
    return items;
  };
}

test("CatalogIndex builds the list once, saves it, and loads it after a restart", async () => {
  const dir = await tempDir();
  const calls: string[] = [];
  const index = new CatalogIndex(dir, fakeTmdb(calls), 0);
  await index.load();
  assert.equal(index.response(), null);
  assert.deepEqual(titles(index), []);

  const now = Date.parse("2026-10-18T12:00:00Z");
  await index.refresh(now);
  // Each sort order stops at the first empty page.
  assert.equal(calls.length, 12);
  assert.equal(calls[0], "movie votes 1 2026-10-18");
  // 80 per kind, less the one title that both sort orders have.
  assert.equal(titles(index).length, 2 * 79);
  assert.deepEqual(titles(index)[0], { id: "tmdb-movie-10100", kind: "movie", title: "movie 10100", year: 2000 });
  assert.equal(index.response()!.tag, String(now));

  // A week has not passed: no TMDB requests.
  await index.refresh(now + 6 * DAY);
  assert.equal(calls.length, 12);

  const restarted = new CatalogIndex(dir, fakeTmdb(), 0);
  await restarted.load();
  assert.equal(titles(restarted).length, 2 * 79);
  assert.equal(restarted.response()!.text, index.response()!.text);
});

test("CatalogIndex tries a failed page once more, and keeps the old list when the build fails", async () => {
  const dir = await tempDir();
  const index = new CatalogIndex(dir, fakeTmdb(), 0);
  const now = Date.parse("2026-10-18T12:00:00Z");
  await index.refresh(now);
  const before = index.response();

  let failures = 0;
  const flaky = fakeTmdb();
  const once = new CatalogIndex(dir, async (...args) => (failures++ === 0 ? Promise.reject(new Error("502")) : flaky(...args)), 0);
  await once.load();
  await once.refresh(now + 8 * DAY);
  assert.equal(once.response()!.tag, String(now + 8 * DAY));

  const broken = new CatalogIndex(dir, async () => Promise.reject(new Error("down")), 0);
  await broken.load();
  await broken.refresh(now + 16 * DAY);
  assert.equal(broken.response()!.tag, String(now + 8 * DAY));
  assert.notEqual(before, null);
});
