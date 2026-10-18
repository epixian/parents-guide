import assert from "node:assert/strict";
import { test } from "node:test";
import { limitParams, migrateKeys, parseLimits } from "../src/client/prefs.js";

function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("migrateKeys copies old keys to the new names and removes the old keys", () => {
  const s = fakeStorage({ "pairents.watchlist": '{"a":1}', "pairents.searchFilter": "tv", other: "x" });
  migrateKeys(s);
  assert.deepEqual(Object.fromEntries(s.map), { watchlist: '{"a":1}', searchFilter: "tv", other: "x" });
});

test("migrateKeys keeps a new key that is already set", () => {
  const s = fakeStorage({ "pairents.thumbs": "old", thumbs: "new" });
  migrateKeys(s);
  assert.deepEqual(Object.fromEntries(s.map), { thumbs: "new" });
});

test("migrateKeys does nothing on a second run", () => {
  const s = fakeStorage({ "pairents.thumbs": "old" });
  migrateKeys(s);
  migrateKeys(s);
  assert.deepEqual(Object.fromEntries(s.map), { thumbs: "old" });
});

test("parseLimits keeps only known topics, levels, and treatments", () => {
  const raw = JSON.stringify({
    max: { violence: 2, profanity: 9, nope: 1, sexual_content: 1.5 },
    hide: { lgbtq: ["approving", "not_present", "bad"], violence: ["approving"] },
  });
  assert.deepEqual(parseLimits(raw), { max: { violence: 2 }, hide: { lgbtq: ["approving"] } });
  assert.deepEqual(parseLimits("not json"), { max: {}, hide: {} });
  assert.deepEqual(parseLimits(null), { max: {}, hide: {} });
});

test("limitParams leaves out hidden topics", () => {
  const limits = parseLimits(JSON.stringify({ max: { violence: 2, profanity: 1 }, hide: { lgbtq: ["approving", "critical"] } }));
  assert.deepEqual(limitParams(limits, new Set(["profanity"])), [
    ["max.violence", "2"],
    ["hide.lgbtq", "critical,approving"],
  ]);
});
