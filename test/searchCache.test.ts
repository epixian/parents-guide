import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SearchCache } from "../src/server/searchCache.js";

const answer = { results: [], warnings: [] };

test("search answers are shared by normalized query and expire", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cache-"));
  const cache = new SearchCache(dir, 1000);
  await cache.set("Star Wars", answer, 0);
  assert.deepEqual(await cache.get("  star   wars ", 999), answer);
  assert.equal(await cache.get("star wars", 1000), null);
  assert.equal(await cache.get("star trek", 0), null);
  await fs.rm(dir, { recursive: true });
});

test("prune deletes expired files only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cache-"));
  const cache = new SearchCache(dir, 60_000);
  await cache.set("old", answer);
  await cache.set("new", answer);
  const old = path.join(dir, "search", (await fs.readdir(path.join(dir, "search")))[0]!);
  const past = new Date(Date.now() - 120_000);
  await fs.utimes(old, past, past);
  assert.equal(await cache.prune(), 1);
  assert.equal((await fs.readdir(path.join(dir, "search"))).length, 1);
  await fs.rm(dir, { recursive: true });
});
