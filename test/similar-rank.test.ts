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
const up = (...liked: string[]) => new Map(liked.map((id) => [id, 1]));

test("rankSimilar puts titles that share tags with liked titles first", () => {
  // animals: 2 liked titles, adventure: 1. c scores 2 (a tag counts once), b 1, the others 0.
  assert.deepEqual(ids(rankSimilar(items, up("liked1", "liked2"), (id) => tags[id])), ["c", "b", "a", "d", "e"]);
});

test("rankSimilar keeps the given order with no marks, or liked titles not in the catalog", () => {
  assert.deepEqual(ids(rankSimilar(items, up(), (id) => tags[id])), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(rankSimilar(items, up("unknown"), (id) => tags[id])), ["a", "b", "c", "d", "e"]);
});

test("rankSimilar keeps the given order for equal scores", () => {
  const same = { ...tags, a: ["adventure"] as ThemeTag[] };
  assert.deepEqual(ids(rankSimilar(items, up("liked1"), (id) => same[id])), ["a", "b", "c", "d", "e"]);
});

test("rankSimilar puts titles that share tags with disliked titles last", () => {
  // liked1 +1, liked2 -1: animals 0, adventure +1. b 1; a, c, d, e 0 in the given order.
  assert.deepEqual(ids(rankSimilar(items, new Map([["liked1", 1], ["liked2", -1]]), (id) => tags[id])), ["b", "a", "c", "d", "e"]);
  // Not interested in liked2 (-0.5): c drops below the titles with no tags.
  assert.deepEqual(ids(rankSimilar(items, new Map([["liked2", -0.5]]), (id) => tags[id])), ["a", "b", "d", "e", "c"]);
});
