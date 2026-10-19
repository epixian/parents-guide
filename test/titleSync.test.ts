import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges } from "../src/client/titles.js";
import type { IndexEntry } from "../src/shared/types.js";

const entry = (id: string, title = id): IndexEntry => ({
  id,
  kind: "movie",
  title,
  years: "2000",
  imageUrl: null,
  addedAt: "2026-10-01T00:00:00Z",
  ratedParts: 1,
  themeTags: [],
  scores: {},
  treatments: {},
});

test("applyChanges replaces changed titles in place, adds new ones, and keeps the other objects", () => {
  const a = entry("a");
  const b = entry("b");
  const base = { tag: "k-1", titles: [a, b] };
  const next = applyChanges(base, "k-3", [entry("b", "B2"), entry("c")]);
  assert.equal(next.tag, "k-3");
  assert.deepEqual(next.titles.map((t) => t.title), ["a", "B2", "c"]);
  // Same object: suggestions keep their prepared text for unchanged titles.
  assert.equal(next.titles[0], a);
  assert.deepEqual(base.titles, [a, b]);

  const same = applyChanges(base, "k-1", []);
  assert.equal(same.titles, base.titles);
});
