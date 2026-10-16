import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateKeys } from "../src/client/prefs.js";

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
