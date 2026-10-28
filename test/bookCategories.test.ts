import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOK_CATEGORIES, BOOK_CATEGORY_GROUPS, normalizeBookCategories } from "../src/shared/bookCategories.js";

test("normalizeBookCategories keeps known categories in list order, with loose spelling", () => {
  assert.deepEqual(normalizeBookCategories(["Fantasy", "Young Adult", "fiction", "Mystery & Thriller", "nope", "fantasy"]), [
    "young-adult",
    "fiction",
    "fantasy",
    "mystery-thriller",
  ]);
});

test("normalizeBookCategories keeps the first answer in a one-only group, and at most three genres", () => {
  assert.deepEqual(normalizeBookCategories(["adult", "young-adult", "fiction", "nonfiction"]), ["adult", "fiction"]);
  assert.deepEqual(
    normalizeBookCategories(["fantasy", "horror", "romance", "classic"]),
    ["fantasy", "horror", "romance"],
  );
});

test("every category belongs to a group and has a unique id", () => {
  const groups = new Set<string>(BOOK_CATEGORY_GROUPS.map((g) => g.id));
  assert.ok(BOOK_CATEGORIES.every((c) => groups.has(c.group)));
  assert.equal(new Set(BOOK_CATEGORIES.map((c) => c.id)).size, BOOK_CATEGORIES.length);
});
