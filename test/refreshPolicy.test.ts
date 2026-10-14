import { test } from "node:test";
import assert from "node:assert/strict";
import { isReleased, parseReleaseDate, shouldRefresh } from "../src/server/refreshPolicy.js";

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

test("parseReleaseDate handles full dates and year-only dates", () => {
  assert.equal(parseReleaseDate("2024-03-15")?.toISOString(), "2024-03-15T00:00:00.000Z");
  assert.equal(parseReleaseDate("1937")?.toISOString(), "1937-01-01T00:00:00.000Z");
  assert.equal(parseReleaseDate(""), null);
  assert.equal(parseReleaseDate("soon"), null);
});

test("release gate", () => {
  assert.equal(isReleased("2026-10-15", day("2026-10-14")), false);
  assert.equal(isReleased("2026-10-14", day("2026-10-14")), true);
  assert.equal(isReleased(null, day("2026-10-14")), false);
});

test("< 1 week old: refresh after 3 days", () => {
  const releaseDate = "2026-10-01";
  const refreshedAt = day("2026-10-01").toISOString();
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-10-03") }), false);
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-10-04") }), true);
});

test("1 week to < 1 month: refresh after 1 week", () => {
  const releaseDate = "2026-10-01";
  const refreshedAt = day("2026-10-06").toISOString();
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-10-12") }), false);
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-10-13") }), true);
});

test("1 month to < 3 months: refresh after 1 month", () => {
  const releaseDate = "2026-01-01";
  const refreshedAt = day("2026-02-10").toISOString();
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-03-09") }), false);
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-03-10") }), true);
});

test("3 months to < 6 months: refresh after 3 months", () => {
  const releaseDate = "2026-01-01";
  const refreshedAt = day("2026-04-01").toISOString();
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-06-30") }), false);
  // Now in the 6 mo - 1 yr bucket (6 month gap), so still no refresh.
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-07-02") }), false);
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-10-02") }), true);
});

test("1 year to < 2 years: refresh after 1 year", () => {
  const releaseDate = "2024-01-01";
  const refreshedAt = day("2025-01-10").toISOString();
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2025-12-31") }), false);
  // 2 years old: stable, no refresh even though more than a year has passed.
  assert.equal(shouldRefresh({ releaseDate, refreshedAt, now: day("2026-02-01") }), false);
});

test(">= 2 years old: never refresh", () => {
  const refreshedAt = day("2000-01-01").toISOString();
  assert.equal(shouldRefresh({ releaseDate: "1999-01-01", refreshedAt, now: day("2026-10-14") }), false);
});

test("unknown release date (books): never refresh", () => {
  const refreshedAt = day("2020-01-01").toISOString();
  assert.equal(shouldRefresh({ releaseDate: null, refreshedAt, now: day("2026-10-14") }), false);
});
