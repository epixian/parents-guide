import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSimilar } from "../src/shared/similar.js";
import type { ThemeTag } from "../src/shared/themes.js";

const tags: Record<string, ThemeTag[]> = {
  liked1: ["animals", "adventure"],
  liked2: ["animals"],
  a: ["betrayal"],
  b: ["adventure"],
  c: ["animals", "animals"],
  d: ["bullying"],
};
const items = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((i) => i.id);

test("rankSimilar puts titles that share tags with liked titles first", () => {
  // animals: 2 liked titles, adventure: 1. c scores 2 (a tag counts once), b 1, the others 0.
  assert.deepEqual(ids(rankSimilar(items, ["liked1", "liked2"], (id) => tags[id])), ["c", "b", "a", "d", "e"]);
});

test("rankSimilar keeps the given order with no liked titles, or liked titles not in the catalog", () => {
  assert.deepEqual(ids(rankSimilar(items, [], (id) => tags[id])), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(rankSimilar(items, ["unknown"], (id) => tags[id])), ["a", "b", "c", "d", "e"]);
});

test("rankSimilar keeps the given order for equal scores", () => {
  const same = { ...tags, a: ["adventure"] as ThemeTag[] };
  assert.deepEqual(ids(rankSimilar(items, ["liked1"], (id) => same[id])), ["a", "b", "c", "d", "e"]);
});
