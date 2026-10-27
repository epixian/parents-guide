import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReportCache } from "../src/server/cache.js";
import { DailyLimit } from "../src/server/dailyLimit.js";
import type { HttpError } from "../src/server/http.js";
import { Popularity } from "../src/server/popularity.js";
import { RateLimiter } from "../src/server/rateLimit.js";
import { ReportService } from "../src/server/reports.js";

const at = (iso: string) => new Date(iso);

test("DailyLimit allows the limit per UTC day, then starts again the next day", () => {
  const limit = new DailyLimit(2);
  assert.equal(limit.take(at("2026-10-27T10:00:00Z")), true);
  assert.equal(limit.take(at("2026-10-27T11:00:00Z")), true);
  assert.equal(limit.take(at("2026-10-27T23:59:59Z")), false);
  assert.equal(limit.used(at("2026-10-27T23:59:59Z")), 2);
  assert.equal(limit.take(at("2026-10-28T00:00:00Z")), true);
  assert.equal(limit.used(at("2026-10-28T00:00:01Z")), 1);
});

test("DailyLimit 0 is no limit", () => {
  const limit = new DailyLimit(0);
  for (let i = 0; i < 1000; i++) assert.equal(limit.take(), true);
});

test("DailyLimit starts from today's live lookups in usage.jsonl, so a restart does not reset it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daily-"));
  const file = path.join(dir, "usage.jsonl");
  const line = (day: string, mode: string) => JSON.stringify({ at: `${day}T08:00:00.000Z`, id: "tmdb-movie-1", mode, cost: 0.01 });
  await fs.writeFile(
    file,
    [line("2026-10-26", "live"), line("2026-10-27", "live"), line("2026-10-27", "batch"), line("2026-10-27", "live"), '{"at":"2026-10-27T0'].join("\n"),
  );
  const now = at("2026-10-27T12:00:00Z");
  const limit = new DailyLimit(3);
  await limit.load(file, now);
  assert.equal(limit.used(now), 2);
  assert.equal(limit.take(now), true);
  assert.equal(limit.take(now), false);

  // No file yet: nothing counted.
  const empty = new DailyLimit(3);
  await empty.load(path.join(dir, "missing.jsonl"), now);
  assert.equal(empty.used(now), 0);
});

test("when the day is full, a new lookup gets a 503 before any catalog or AI request", async () => {
  const daily = new DailyLimit(1);
  daily.take();
  const cache = { get: async () => null } as unknown as ReportCache;
  const reports = new ReportService(cache, new RateLimiter(30, 60_000), new Popularity(null), undefined, undefined, daily);
  // tmdb-movie-1 would need TMDB and the AI. The limit answers first, so no request is made.
  await assert.rejects(reports.getReport("tmdb-movie-1", "1.2.3.4"), (err: HttpError) => err.status === 503);
});
