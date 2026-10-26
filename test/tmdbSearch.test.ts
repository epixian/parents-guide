import { test } from "node:test";
import assert from "node:assert/strict";
import { splitYear } from "../src/server/catalog/tmdb.js";

test("splitYear reads a trailing year, with or without brackets", () => {
  assert.deepEqual(splitYear("bella 2006"), { title: "bella", year: 2006 });
  assert.deepEqual(splitYear(" Bella (2006) "), { title: "Bella", year: 2006 });
  assert.deepEqual(splitYear("Blade Runner 2049"), { title: "Blade Runner", year: 2049 });
});

test("splitYear ignores queries without title text and a trailing year", () => {
  assert.equal(splitYear("1917"), null);
  assert.equal(splitYear("bella"), null);
  assert.equal(splitYear("2001 a space odyssey"), null);
  assert.equal(splitYear("room 237"), null);
});
