import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend } from "../src/shared/recommend.js";
import type { ThemeTag } from "../src/shared/themes.js";
import type { IndexEntry } from "../src/shared/types.js";

const title = (id: string, themeTags: ThemeTag[], violence = 0): IndexEntry => ({
  id,
  kind: "movie",
  title: id,
  years: null,
  imageUrl: null,
  addedAt: "2026-10-01T00:00:00Z",
  ratedParts: 1,
  themeTags,
  scores: { violence },
  treatments: {},
});

const opts = { categories: ["violence" as const], limit: 10 };
const ids = (list: IndexEntry[]) => list.map((t) => t.id);

test("recommend ranks by tags shared with liked titles, less those of disliked titles", () => {
  const catalog = [
    title("liked", ["animals", "adventure"]),
    title("disliked", ["betrayal"]),
    title("a", ["animals", "adventure"]),
    title("b", ["animals", "betrayal"]),
    title("c", ["adventure"]),
    title("d", ["bullying"]),
  ];
  // a: 2; c: 1; b: 1 - 1 = 0 (left out); d: 0 (left out). Thumbed titles are left out.
  assert.deepEqual(ids(recommend(catalog, { liked: "up", disliked: "down" }, opts)), ["a", "c"]);
  assert.deepEqual(recommend(catalog, { disliked: "down" }, opts), []);
  assert.deepEqual(ids(recommend(catalog, { liked: "up" }, { ...opts, exclude: new Set(["a"]) })), ["b", "c"]);
});

test("recommend counts concern scores above the liked titles' highest only with 3 liked titles", () => {
  const liked = ["l1", "l2", "l3"].map((id) => title(id, ["animals"], 1));
  const catalog = [...liked, title("calm", ["animals"], 1), title("violent", ["animals"], 4)];
  const thumbs = { l1: "up", l2: "up", l3: "up" } as const;
  // Both match 3 on tags; "violent" is 3 points above the limit of 1, so it drops to 0.
  assert.deepEqual(ids(recommend(catalog, thumbs, opts)), ["calm"]);
  // A hidden category does not count.
  assert.deepEqual(ids(recommend(catalog, thumbs, { ...opts, categories: [] })), ["calm", "violent"]);
  // With fewer liked titles there is no limit yet. l2 and l3 are not thumbed, so they come too.
  assert.deepEqual(ids(recommend(catalog, { l1: "up" }, opts)), ["l2", "l3", "calm", "violent"]);
});
