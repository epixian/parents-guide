import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkInfo } from "../src/shared/types.js";
import { audienceScore } from "../src/server/catalog/types.js";
import { mergeInfo } from "../src/server/reports.js";

const info = (publisher: string): WorkInfo => ({
  years: "1937",
  rating: null,
  credits: [
    { label: "Author", entries: [{ name: "J.R.R. Tolkien", url: null }] },
    { label: "Publisher", entries: [{ name: publisher, url: null }] },
  ],
  imageUrl: null,
  source: null,
});

test("reloaded book facts keep the AI's publisher", () => {
  const merged = mergeInfo("book", info("George Allen & Unwin"), info("Houghton Mifflin"));
  assert.equal(merged.credits.find((c) => c.label === "Publisher")?.entries[0]?.name, "George Allen & Unwin");
  assert.equal(mergeInfo("movie", info("A"), info("B")).credits[1]?.entries[0]?.name, "B");
});

test("audience score needs enough votes and rounds to one decimal", () => {
  assert.deepEqual(audienceScore("TMDB", 8.7134, 27000, 10, 25), { source: "TMDB", average: 8.7, scale: 10, count: 27000 });
  assert.equal(audienceScore("TMDB", 9, 24, 10, 25), null);
  assert.equal(audienceScore("Open Library", 0, 50, 5, 10), null);
});
