import { test } from "node:test";
import assert from "node:assert/strict";
import { fitFor, markSignals, MIN_FIT, modelFromTable, scoreTable } from "../src/shared/taste.js";
import type { ThemeTag } from "../src/shared/themes.js";
import type { IndexEntry } from "../src/shared/types.js";

const title = (id: string, themeTags: ThemeTag[], mood?: [number, number, number], genres?: string[]): IndexEntry => ({
  id,
  kind: "movie",
  title: id,
  years: null,
  imageUrl: null,
  addedAt: "2026-10-01T00:00:00Z",
  ratedParts: 1,
  themeTags,
  scores: {},
  treatments: {},
  ...(mood ? { mood: { tone: mood[0], feeling: mood[1], depth: mood[2] } } : {}),
  ...(genres ? { genres } : {}),
});

// Funny animal titles (uplifting, low-key, light) and grim war titles (bleak, powerful, profound).
const fun = (id: string, mood: [number, number, number] | undefined = [5, 2, 2]) => title(id, ["animals", "humor", "friendship"], mood);
const grim = (id: string) => title(id, ["war", "death-and-grief", "survival"], [1, 5, 5]);
const catalog = [
  ...["f1", "f2", "f3", "f4", "f5"].map((id) => fun(id)),
  ...["g1", "g2", "g3", "g4"].map(grim),
  fun("no-mood", undefined),
  title("far", ["mystery", "school"], [3, 1, 3]),
  ...Array.from({ length: 20 }, (_, i) => title(`other${i}`, ["family", "good-vs-evil"], [4, 3, 3])),
];
const clear = { f1: "up", f2: "up", f3: "up", f4: "up", g1: "down", g2: "down" } as const;

test("markSignals: liked 1, disliked -1, not interested -0.5, and a thumb wins", () => {
  assert.deepEqual(markSignals({ a: "up", b: "down" }, { b: "t", c: "t" }), new Map([["c", -0.5], ["b", -1], ["a", 1]]));
});

test("fitFor finds a strong match for a title like the liked ones", () => {
  const fit = fitFor("f5", catalog, clear);
  assert.ok(fit && fit.score >= MIN_FIT);
  assert.deepEqual(fit.likedNear.map((t) => t.id).sort(), ["f1", "f2", "f3", "f4"]);
  // Tags alone are enough when the title has no mood.
  assert.ok(fitFor("no-mood", catalog, clear));
});

test("fitFor gives no fit for a title like the disliked ones, far from all marks, or already marked", () => {
  assert.equal(fitFor("g3", catalog, clear), null);
  assert.equal(fitFor("far", catalog, clear), null);
  assert.equal(fitFor("f1", catalog, clear), null);
  assert.equal(fitFor("f5", catalog, clear, { f5: "t" }), null);
  assert.equal(fitFor("unknown", catalog, clear), null);
});

test("fitFor needs enough marks, with at least one no", () => {
  const { g2: _, ...five } = clear;
  assert.equal(fitFor("f5", catalog, five), null);
  // "Not interested" counts as a no and as a mark.
  assert.ok(fitFor("f5", catalog, five, { g3: "t" }));
  assert.equal(fitFor("f5", catalog, { f1: "up", f2: "up", f3: "up", f4: "up", g1: "up", g2: "up" }), null);
});

test("fitFor gives no fit when the thumbs do not predict each other (self-check)", () => {
  // f5 (disliked) predicts as liked, and g1 has no similar marks: 4 of 6 are correct.
  // no-mood scores well above MIN_FIT and nothing scores higher, so only the self-check stops it.
  const mixed = { f1: "up", f2: "up", f3: "up", f4: "up", f5: "down", g1: "down" } as const;
  assert.equal(fitFor("no-mood", catalog, mixed), null);
  // g2 and g1 now predict each other: 6 of 7 are correct.
  assert.ok(fitFor("no-mood", catalog, { ...mixed, g2: "down" }));
});

test("fitFor does not self-check Not interested titles, which are near the liked ones by design", () => {
  // Three Not interested titles like the liked ones would fail the self-check (6 of 9).
  const near = ["n1", "n2", "n3"].map((id) => title(id, ["animals", "humor", "adventure"], [5, 2, 2]));
  assert.ok(fitFor("no-mood", [...catalog, ...near], clear, { n1: "t", n2: "t", n3: "t" }));
});

test("fitFor gives no fit to a good score when more than the top share of titles score higher", () => {
  // "partial" scores above MIN_FIT, but f5 and no-mood score higher: 2 of 33 titles is more than 5%.
  const partial = title("partial", ["animals", "humor"], [5, 2, 2]);
  assert.equal(fitFor("partial", [...catalog, partial], clear), null);
  // With more titles in the catalog, the same 2 higher titles are less than 5% of it.
  const filler = Array.from({ length: 20 }, (_, i) => title(`more${i}`, ["history"], [2, 4, 4]));
  assert.ok(fitFor("partial", [...catalog, partial, ...filler], clear));
});

test("fitFor ranks genre above theme tags and mood", () => {
  // Same tags and mood: liked thrillers, disliked cartoons. Only the genres tell them apart.
  const tags: ThemeTag[] = ["mystery", "crime-and-justice"];
  const thriller = (id: string) => title(id, tags, [3, 2, 3], ["Thriller", "Crime"]);
  const cartoon = (id: string) => title(id, tags, [3, 2, 3], ["Animation", "Comedy"]);
  const genreCatalog = [
    ...["t1", "t2", "t3", "t4", "t5"].map(thriller),
    ...["c1", "c2", "c3", "c4", "c5"].map(cartoon),
    ...Array.from({ length: 20 }, (_, i) => title(`other${i}`, ["family"], [4, 3, 3], ["Family"])),
  ];
  const marks = { t1: "up", t2: "up", t3: "up", t4: "up", c1: "down", c2: "down", c3: "down", c4: "down" } as const;
  const fit = fitFor("t5", genreCatalog, marks);
  assert.ok(fit);
  assert.deepEqual(fit.likedNear.map((t) => t.id).sort(), ["t1", "t2", "t3", "t4"]);
  assert.equal(fitFor("c5", genreCatalog, marks), null);
});

test("fitFor uses the new marks on the same catalog array (the kept scores reset)", () => {
  assert.ok(fitFor("f5", catalog, clear));
  const flipped = { f1: "down", f2: "down", f3: "down", f4: "down", g1: "up", g2: "up" } as const;
  assert.equal(fitFor("f5", catalog, flipped), null);
  assert.ok(fitFor("g3", catalog, flipped));
  assert.ok(fitFor("f5", catalog, clear));
});

test("a score table (as the worker sends it) gives the same fits as the model", () => {
  const signals = markSignals(clear);
  const slim = catalog.map(({ id, themeTags, genres, mood }) => ({ id, themeTags, genres, mood }));
  const table = structuredClone(scoreTable(slim, signals));
  assert.ok(table);
  const model = modelFromTable(table, new Map(catalog.map((t) => [t.id, t])));
  for (const t of catalog) assert.deepEqual(fitFor(t.id, catalog, clear, {}, model), fitFor(t.id, catalog, clear));
  assert.equal(scoreTable(slim, markSignals({ f1: "up" })), null);
});
