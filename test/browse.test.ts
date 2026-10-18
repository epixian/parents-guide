import { test } from "node:test";
import assert from "node:assert/strict";
import type { IndexEntry } from "../src/shared/types.js";
import { browseTitles, parseBrowseQuery, suggestTitles } from "../src/shared/browse.js";

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
  const mixed = [...TITLES, entry("d", { kind: "book", title: "Dune" })];
  assert.deepEqual(ids("kind=tv&kind=book&sort=title", mixed), ["c", "d"]);
  assert.deepEqual(ids("kind=movie,book&sort=title", mixed), ["a", "b", "d"]);
  assert.deepEqual(ids("q=amelie", TITLES), ["a"]);
  assert.deepEqual(ids("tag=war&tag=friendship", TITLES), ["c"]);
});

test("streaming on my services: a title passes when any of its services is not hidden", () => {
  const titles = [
    entry("a", { providers: [8, 15] }),
    entry("b", { providers: [337] }),
    entry("c", { title: "No streams" }),
  ];
  assert.deepEqual(ids("streaming=mine&sort=title", titles), ["a", "b"]);
  assert.deepEqual(ids("streaming=mine&hideService=8,337&sort=title", titles), ["a"]);
  assert.deepEqual(ids("streaming=mine&hideService=8&hideService=15&sort=title", titles), ["b"]);
  assert.deepEqual(ids("hideService=8,15,337&sort=title", titles), ["a", "b", "c"]);
  assert.throws(() => parse("streaming=yes"), /streaming/);
  assert.throws(() => parse("hideService=netflix"), /hideService/);
});

test("mood: a title passes when its level is checked on every scale with levels", () => {
  const titles = [
    entry("a", { mood: { tone: 5, feeling: 2, depth: 2 } }),
    entry("b", { mood: { tone: 4, feeling: 4, depth: 4 } }),
    entry("c"),
  ];
  assert.deepEqual(ids("tone=4,5&sort=title", titles), ["a", "b"]);
  assert.deepEqual(ids("tone=4&tone=5&depth=4&sort=title", titles), ["b"]);
  assert.deepEqual(ids("sort=title", titles), ["a", "b", "c"]);
  assert.throws(() => parse("feeling=6"), /feeling/);
});

test("max score and hidden treatments", () => {
  assert.deepEqual(ids("max.violence=3&sort=title", TITLES), ["a", "c"]);
  // Any season with an approving treatment hides the series.
  assert.deepEqual(ids("hide.lgbtq=approving&sort=title", TITLES), ["a", "b"]);
  assert.deepEqual(ids("hide.lgbtq=critical&sort=title", TITLES), ["a", "b", "c"]);
  assert.deepEqual(parse("hide.lgbtq=critical&hide.lgbtq=approving,critical").hide, { lgbtq: ["critical", "approving"] });
});

test("score sort: highest user score first, titles with no score last", () => {
  const titles = [entry("a", { userScore: 70 }), entry("b"), entry("c", { userScore: 84 })];
  assert.deepEqual(ids("sort=score", titles), ["c", "a", "b"]);
});

test("random sort: one order per seed, so pages do not repeat titles", () => {
  const titles = Array.from({ length: 20 }, (_, i) => entry(`t${i}`));
  const order = ids("sort=random&seed=7", titles);
  assert.deepEqual(ids("sort=random&seed=7", titles), order);
  assert.notDeepEqual(ids("sort=random&seed=8", titles), order);
  assert.deepEqual([...ids("sort=random&seed=7&limit=10", titles), ...ids("sort=random&seed=7&limit=10&offset=10", titles)], order);
  assert.deepEqual([...order].sort(), titles.map((t) => t.id).sort());
  assert.throws(() => parse("sort=random&seed=-1"), /seed/);
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

test("suggestTitles ranks exact, then starts-with, then word-start, then contains", () => {
  const titles = [
    entry("contains", { title: "Backstory Blues" }),
    entry("word", { title: "The Story of Us" }),
    entry("long-start", { title: "Story of a Girl Who Was Very Long" }),
    entry("start", { title: "Story Time" }),
    entry("exact", { title: "Story" }),
    entry("none", { title: "Braveheart" }),
  ];
  assert.deepEqual(
    suggestTitles(titles, "story", 10).map((s) => s.id),
    ["exact", "start", "long-start", "word", "contains"],
  );
  assert.deepEqual(
    // Inside a word everywhere: shorter titles first, then by name.
    suggestTitles(titles, "ory", 10).map((s) => s.id),
    ["exact", "start", "contains", "word", "long-start"],
  );
});

test("suggestTitles ignores case, accents, and punctuation", () => {
  const titles = [entry("a", { title: "Amélie" }), entry("s", { title: "Spider-Man: No Way Home" })];
  assert.deepEqual(suggestTitles(titles, "AMEL", 10).map((s) => s.id), ["a"]);
  assert.deepEqual(suggestTitles(titles, "spider man", 10).map((s) => s.id), ["s"]);
  assert.deepEqual(suggestTitles(titles, "spiderman", 10).map((s) => s.id), []);
  assert.deepEqual(suggestTitles(titles, "!!", 10), []);
});

test("suggestTitles keeps the limit and returns only the card fields", () => {
  const titles = ["Cars", "Cars 2", "Cars 3"].map((t) => entry(t, { title: t, imageUrl: "x.jpg" }));
  assert.deepEqual(suggestTitles(titles, "cars", 2), [
    { id: "Cars", kind: "movie", title: "Cars", years: "2000", imageUrl: "x.jpg" },
    { id: "Cars 2", kind: "movie", title: "Cars 2", years: "2000", imageUrl: "x.jpg" },
  ]);
});
