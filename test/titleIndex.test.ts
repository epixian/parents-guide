import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CATEGORIES } from "../src/shared/categories.js";
import { normalizeThemeTags } from "../src/shared/themes.js";
import type { Report } from "../src/shared/types.js";
import { Popularity } from "../src/server/popularity.js";
import { RateLimiter } from "../src/server/rateLimit.js";
import { ReportService } from "../src/server/reports.js";
import { TitleChangeLog } from "../src/server/titleChanges.js";
import { TitleIndex } from "../src/server/titleIndex.js";

function report(id: string, kind: Report["kind"], addedAt: string, extra: Partial<Report> = {}): Report {
  const categories = Object.fromEntries(
    CATEGORIES.map((c) => [c.id, { score: 0, treatment: c.hasTreatment ? "not_present" : null, notes: "" }]),
  ) as Report["categories"];
  return {
    schemaVersion: 2,
    id,
    kind,
    title: id,
    subtitle: null,
    releaseDate: "2000-01-01",
    refreshedAt: addedAt,
    addedAt,
    model: "test",
    promptVersion: 4,
    summary: "",
    confidence: "high",
    categories,
    positives: [],
    ...extra,
  };
}

test("TV seasons merge into one series entry", () => {
  const index = new TitleIndex();
  const s1 = report("tmdb-tv-1399-s01", "tv-season", "2026-10-01T00:00:00Z", { themeTags: ["war", "family"] });
  s1.categories.violence.score = 3;
  s1.categories.lgbtq = { score: 2, treatment: "matter_of_fact", notes: "" };
  const s2 = report("tmdb-tv-1399-s02", "tv-season", "2026-10-03T00:00:00Z", { themeTags: ["war", "betrayal"] });
  s2.categories.violence.score = 5;
  s2.categories.lgbtq = { score: 1, treatment: "approving", notes: "" };
  index.add(s1);
  index.add(s2);

  const [series] = index.titles();
  assert.equal(index.titles().length, 1);
  assert.equal(series!.id, "tmdb-tv-1399");
  assert.equal(series!.ratedParts, 2);
  assert.equal(series!.addedAt, "2026-10-03T00:00:00Z");
  assert.equal(series!.scores.violence, 5);
  assert.deepEqual(series!.treatments.lgbtq, ["matter_of_fact", "approving"]);
  assert.equal(series!.themeTags[0], "war"); // most frequent first
  assert.deepEqual([...series!.themeTags].sort(), ["betrayal", "family", "war"]);
});

test("recent lists newest first per kind, with a limit", () => {
  const index = new TitleIndex();
  index.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  index.add(report("tmdb-movie-2", "movie", "2026-10-03T00:00:00Z"));
  index.add(report("tmdb-movie-3", "movie", "2026-10-02T00:00:00Z"));
  index.add(report("ol-OL1W", "book", "2026-10-01T00:00:00Z"));

  const recent = index.recent(2);
  assert.deepEqual(recent.movie.map((m) => m.id), ["tmdb-movie-2", "tmdb-movie-3"]);
  assert.deepEqual(recent.book.map((b) => b.id), ["ol-OL1W"]);
  assert.deepEqual(recent.tv, []);
});

test("a refreshed result replaces its old index entry", () => {
  const index = new TitleIndex();
  const first = report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z");
  index.add(first);
  index.add({ ...first, refreshedAt: "2026-10-09T00:00:00Z", themeTags: ["humor"] });
  assert.equal(index.titles().length, 1);
  assert.deepEqual(index.titles()[0]!.themeTags, ["humor"]);
});

test("normalizeThemeTags keeps known tags and fixes spelling", () => {
  assert.deepEqual(normalizeThemeTags(["Coming of Age", "friendship", "space opera", "found_family", "friendship"]), [
    "coming-of-age",
    "friendship",
    "found-family",
  ]);
});

test("version goes up on each add, and titles() is reused until then", () => {
  const index = new TitleIndex();
  index.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  const v = index.version;
  const first = index.titles();
  assert.equal(index.titles(), first);
  index.recent(5); // Sorts a copy, not the shared list.
  assert.equal(index.titles(), first);
  index.add(report("tmdb-movie-2", "movie", "2026-10-02T00:00:00Z"));
  assert.equal(index.version, v + 1);
  assert.notEqual(index.titles(), first);
  assert.equal(index.titles().length, 2);
});

test("a save that changes nothing in the index keeps the version", () => {
  const index = new TitleIndex();
  const r = report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z");
  index.add(r);
  const v = index.version;
  index.add({ ...r, refreshedAt: "2026-10-05T00:00:00Z", summary: "New words" });
  index.add({ ...r, mood: { tone: 3, feeling: 2, depth: 2, note: "", version: 1 } });
  assert.equal(index.version, v);
  index.add({ ...r, mood: { tone: 3, feeling: 2, depth: 2, note: "", version: 2 } });
  assert.equal(index.version, v + 1);
  assert.deepEqual(index.titles()[0]!.mood, { tone: 3, feeling: 2, depth: 2 });
  const scored = structuredClone(r);
  scored.categories.violence.score = 2;
  index.add(scored);
  assert.equal(index.version, v + 2);
});

test("streaming services join the series entry, and only a change moves the version", () => {
  const index = new TitleIndex();
  index.add(report("tmdb-tv-7-s01", "tv-season", "2026-10-01T00:00:00Z"));
  index.add(report("ol-1", "book", "2026-10-01T00:00:00Z"));
  assert.deepEqual(index.screenIds(), ["tmdb-tv-7"]);
  index.setProviders("tmdb-tv-7", [15, 8, 15]);
  const v = index.version;
  assert.deepEqual(index.titles().find((t) => t.id === "tmdb-tv-7")?.providers, [8, 15]);
  index.setProviders("tmdb-tv-7", [8, 15]);
  assert.equal(index.version, v);
  index.setProviders("tmdb-tv-7", []);
  assert.equal(index.version, v + 1);
  assert.equal(index.titles().find((t) => t.id === "tmdb-tv-7")?.providers, undefined);
});

test("user score: a percent of the source's scale, from the newest season that has one", () => {
  const index = new TitleIndex();
  const info = (average: number, scale: number) => ({
    years: null, rating: null, credits: [], imageUrl: null, source: null,
    audience: { source: "x", average, scale, count: 100 },
  });
  index.add(report("ol-1", "book", "2026-10-01T00:00:00Z", { info: info(4.2, 5) }));
  index.add(report("tmdb-tv-7-s01", "tv-season", "2026-10-01T00:00:00Z", { info: info(8.1, 10) }));
  index.add(report("tmdb-tv-7-s02", "tv-season", "2026-10-02T00:00:00Z"));
  index.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  const score = (id: string) => index.titles().find((t) => t.id === id)?.userScore;
  assert.equal(score("ol-1"), 84);
  assert.equal(score("tmdb-tv-7"), 81);
  assert.equal(score("tmdb-movie-1"), undefined);
});

test("changedSince lists the titles changed at or after a time, by series for TV", () => {
  let now = 1000;
  const index = new TitleIndex(new TitleChangeLog(null), () => now);
  index.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  index.add(report("tmdb-tv-1399-s01", "tv-season", "2026-10-01T00:00:00Z"));
  // Nothing counts before tracking starts.
  assert.equal(index.newestChange, 0);
  index.startTracking();
  assert.equal(index.newestChange, 1000);
  assert.deepEqual(index.changedSince(0).map((t) => t.id), ["tmdb-movie-1", "tmdb-tv-1399"]);
  assert.deepEqual(index.changedSince(1000), []);

  now = 2000;
  index.add(report("tmdb-tv-1399-s02", "tv-season", "2026-10-02T00:00:00Z"));
  index.add(report("tmdb-movie-2", "movie", "2026-10-02T00:00:00Z"));
  index.setProviders("tmdb-movie-1", [8]);
  const changed = index.changedSince(1000);
  assert.deepEqual(changed.map((t) => t.id).sort(), ["tmdb-movie-1", "tmdb-movie-2", "tmdb-tv-1399"]);
  assert.equal(changed.find((t) => t.id === "tmdb-tv-1399")!.ratedParts, 2);
  assert.equal(index.newestChange, 2000);

  // A save that changes nothing is not a change.
  now = 3000;
  index.add(report("tmdb-movie-2", "movie", "2026-10-02T00:00:00Z"));
  assert.deepEqual(index.changedSince(2000), []);

  // A change in the same millisecond as the newest one still gets a later time.
  index.add(report("tmdb-movie-4", "movie", "2026-10-03T00:00:00Z"));
  assert.deepEqual(index.changedSince(2000).map((t) => t.id), ["tmdb-movie-4"]);
  assert.equal(index.newestChange, 3000);
  now = 3000;
  index.add(report("tmdb-movie-5", "movie", "2026-10-03T00:00:00Z"));
  assert.deepEqual(index.changedSince(3000).map((t) => t.id), ["tmdb-movie-5"]);
  assert.equal(index.newestChange, 3001);
});

test("after a restart, only titles whose entry differs from the log count as changed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changes-"));
  const file = path.join(dir, "title-changes.json");
  const first = new TitleChangeLog(file);
  const before = new TitleIndex(first, () => 1000);
  before.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  before.add(report("tmdb-movie-2", "movie", "2026-10-01T00:00:00Z"));
  before.setProviders("tmdb-movie-1", [8]);
  before.startTracking();
  await first.flush();

  // Restart: the same results and services, plus one result a script wrote meanwhile.
  const log = new TitleChangeLog(file);
  await log.load();
  const after = new TitleIndex(log, () => 5000);
  after.add(report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"));
  after.add(report("tmdb-movie-2", "movie", "2026-10-01T00:00:00Z"));
  after.add(report("tmdb-movie-3", "movie", "2026-10-02T00:00:00Z"));
  // Services not loaded yet would change movie 1's entry: load them before tracking.
  after.setProviders("tmdb-movie-1", [8]);
  after.startTracking();
  assert.deepEqual(after.changedSince(1000).map((t) => t.id), ["tmdb-movie-3"]);
  assert.equal(after.newestChange, 5000);
});

test("titleChanges sends the changes since a tag, also after a restart, and reset for a bad tag", async () => {
  const saved = [report("tmdb-movie-1", "movie", "2026-10-01T00:00:00Z"), report("tmdb-movie-2", "movie", "2026-10-01T00:00:00Z")];
  const cache = { listAll: async () => saved, get: async () => null, set: async () => {} };
  const log = new TitleChangeLog(null);
  let providersAsked: string[] = [];
  const reports = new ReportService(cache, new RateLimiter(1, 1000), new Popularity(null), log, async (ids, save) => {
    providersAsked = ids;
    save("tmdb-movie-1", [8]);
  });
  const { changeTag, titles } = await reports.titles();
  assert.deepEqual(providersAsked, ["tmdb-movie-1", "tmdb-movie-2"]);
  assert.deepEqual(titles[0]!.providers, [8]);
  assert.deepEqual(await reports.titleChanges(changeTag), { tag: changeTag, changed: [] });

  // A restart with the same log: the old tag still works.
  const restarted = new ReportService(cache, new RateLimiter(1, 1000), new Popularity(null), log, async (_ids, save) => {
    save("tmdb-movie-1", [8]);
  });
  assert.deepEqual(await restarted.titleChanges(changeTag), { tag: changeTag, changed: [] });

  // Not a tag, newer than the list, or most titles changed: the whole list.
  for (const bad of ["", "nonsense", "k1-7", String(Number(changeTag) + 1), "0"]) {
    assert.equal("reset" in (await restarted.titleChanges(bad)), true, bad);
  }
});
