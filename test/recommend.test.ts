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

test("recommend leaves out titles marked Not interested and counts them as a weak no", () => {
  const catalog = [
    title("liked", ["animals", "adventure"]),
    title("skip", ["adventure"]),
    title("a", ["animals"]),
    title("c", ["adventure"]),
  ];
  // adventure: 1 - 0.5 = 0.5, animals: 1. "skip" is left out.
  assert.deepEqual(ids(recommend(catalog, { liked: "up" }, { ...opts, notInterested: { skip: "2026-10-01" } })), ["a", "c"]);
});

test("recommend uses the taste model (tags and mood) once the marks are a strong enough signal", () => {
  const withMood = (id: string, tags: ThemeTag[], mood: [number, number, number]): IndexEntry => ({
    ...title(id, tags),
    mood: { tone: mood[0], feeling: mood[1], depth: mood[2] },
  });
  const catalog = [
    ...["l1", "l2", "l3", "l4"].map((id) => withMood(id, ["animals", "humor", "friendship"], [5, 2, 2])),
    ...["d1", "d2"].map((id) => withMood(id, ["war", "death-and-grief", "survival"], [1, 5, 5])),
    // All the liked tags, but the mood of the disliked titles.
    withMood("tags", ["animals", "humor", "friendship"], [1, 5, 5]),
    // Fewer liked tags, but the mood of the liked titles.
    withMood("mood", ["animals", "humor"], [5, 2, 2]),
  ];
  const thumbs = { l1: "up", l2: "up", l3: "up", l4: "up", d1: "down", d2: "down" } as const;
  assert.deepEqual(ids(recommend(catalog, thumbs, opts)), ["mood", "tags"]);
  // With 5 marks there is no model yet: the tag sum puts "tags" first.
  const { d2: _, ...five } = thumbs;
  assert.deepEqual(ids(recommend(catalog, five, opts)), ["tags", "mood"]);
});
