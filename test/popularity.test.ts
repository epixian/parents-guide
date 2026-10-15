import { test } from "node:test";
import assert from "node:assert/strict";
import { Popularity } from "../src/server/popularity.js";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

test("one view per visitor per title per day", () => {
  const p = new Popularity(null);
  const now = at("2026-10-14");
  p.record("tmdb-movie-1", "a", now);
  p.record("tmdb-movie-1", "a", now); // reload: not counted
  p.record("tmdb-movie-1", "b", now);
  assert.deepEqual(p.trending(10, now), [{ id: "tmdb-movie-1", score: 2, visitors: 2 }]);
});

test("a title needs at least two visitors to trend", () => {
  const p = new Popularity(null);
  const now = at("2026-10-14");
  p.record("tmdb-movie-1", "a", now);
  assert.deepEqual(p.trending(10, now), []);
});

test("recent views weigh more than older views", () => {
  const p = new Popularity(null);
  // Older title: 3 visitors five days ago. Newer title: 2 visitors today.
  for (const v of ["a", "b", "c"]) p.record("old", v, at("2026-10-09"));
  for (const v of ["a", "b"]) p.record("new", v, at("2026-10-14"));
  const ranked = p.trending(10, at("2026-10-14"));
  assert.deepEqual(ranked.map((t) => t.id), ["new", "old"]);
  assert.ok(Math.abs(ranked[1]!.score - 3 * 0.75 ** 5) < 1e-9);
});

test("views older than the 7-day window do not count", () => {
  const p = new Popularity(null);
  for (const v of ["a", "b"]) p.record("tmdb-movie-1", v, at("2026-10-01"));
  assert.deepEqual(p.trending(10, at("2026-10-14")), []);
});

test("the same visitor counts again on a new day", () => {
  const p = new Popularity(null);
  p.record("tmdb-movie-1", "a", at("2026-10-13"));
  p.record("tmdb-movie-1", "a", at("2026-10-14"));
  assert.equal(p.trending(10, at("2026-10-14"))[0]?.visitors, 2);
});
