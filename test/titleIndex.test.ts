import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES } from "../src/shared/categories.js";
import { normalizeThemeTags } from "../src/shared/themes.js";
import type { Report } from "../src/shared/types.js";
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
