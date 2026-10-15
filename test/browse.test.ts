import { test } from "node:test";
import assert from "node:assert/strict";
import type { IndexEntry } from "../src/shared/types.js";
import { browseTitles, parseBrowseQuery } from "../src/server/browse.js";

function entry(id: string, extra: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id,
    kind: "movie",
    title: id,
    years: "2000",
    imageUrl: null,
    addedAt: "2026-10-01T00:00:00Z",
    ratedParts: 1,
    themeTags: [],
    scores: {},
    treatments: {},
    ...extra,
  };
}

const parse = (qs: string) => parseBrowseQuery(new URLSearchParams(qs));
const ids = (qs: string, titles: IndexEntry[]) => browseTitles(titles, parse(qs)).items.map((t) => t.id);

const TITLES = [
  entry("a", { title: "Amélie", years: "2001", themeTags: ["friendship", "love-and-romance"], scores: { violence: 1 } }),
  entry("b", { title: "Braveheart", years: "1995", themeTags: ["war", "courage"], scores: { violence: 5 } }),
  entry("c", {
    kind: "tv",
    title: "Clone Wars",
    years: "2008–2020",
    addedAt: "2026-10-05T00:00:00Z",
    themeTags: ["war", "friendship"],
    scores: { violence: 3, lgbtq: 2 },
    treatments: { lgbtq: ["matter_of_fact", "approving"] },
  }),
];

test("defaults sort newest added first", () => {
  assert.deepEqual(ids("", TITLES), ["c", "a", "b"]);
});

test("filters by kind, title text without accents, and every tag", () => {
  assert.deepEqual(ids("kind=tv", TITLES), ["c"]);
  assert.deepEqual(ids("q=amelie", TITLES), ["a"]);
  assert.deepEqual(ids("tag=war&tag=friendship", TITLES), ["c"]);
});

test("max score and hidden treatments", () => {
  assert.deepEqual(ids("max.violence=3&sort=title", TITLES), ["a", "c"]);
  // Any season with an approving treatment hides the series.
  assert.deepEqual(ids("hide.lgbtq=approving&sort=title", TITLES), ["a", "b"]);
  assert.deepEqual(ids("hide.lgbtq=critical&sort=title", TITLES), ["a", "b", "c"]);
  assert.deepEqual(parse("hide.lgbtq=critical&hide.lgbtq=approving,critical").hide, { lgbtq: ["critical", "approving"] });
});

test("year sort, paging, and tag counts over all matches", () => {
  const res = browseTitles(TITLES, parse("sort=year&limit=1&offset=1"));
  assert.equal(res.total, 3);
  assert.deepEqual(res.items.map((t) => t.id), ["a"]);
  assert.deepEqual(res.tags.slice(0, 2), [
    { tag: "friendship", count: 2 },
    { tag: "war", count: 2 },
  ]);
});

test("rejects bad values", () => {
  assert.throws(() => parse("kind=game"), /kind/);
  assert.throws(() => parse("tag=nonsense"), /theme tag/);
  assert.throws(() => parse("max.violence=9"), /max.violence/);
  assert.throws(() => parse("max.nope=1"), /Unknown topic/);
  assert.throws(() => parse("hide.violence=approving"), /no treatment/);
  assert.throws(() => parse("hide.lgbtq=not_present"), /treatment/);
  assert.throws(() => parse("limit=500"), /limit/);
});
