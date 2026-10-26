import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBackup, parseBackup, restoreBackup } from "../src/client/backup.js";

function memoryStore(values: Record<string, string>) {
  const map = new Map(Object.entries(values));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("makeBackup keeps the choices, not the first-visit tip", () => {
  const store = memoryStore({ thumbs: '{"tmdb-movie-1":"up"}', concernsTipSeen: "1" });
  const backup = makeBackup(store, new Date("2026-10-25T12:00:00Z"));
  assert.deepEqual(backup, {
    app: "parents-guide",
    version: 1,
    savedAt: "2026-10-25T12:00:00.000Z",
    data: { thumbs: '{"tmdb-movie-1":"up"}' },
  });
});

test("a backup survives the round trip, and restore removes keys it does not have", () => {
  const backup = parseBackup(JSON.stringify(makeBackup(memoryStore({ watchlist: "{}", searchFilter: "movie" }))))!;
  const target = memoryStore({ thumbs: '{"x":"down"}', concernsTipSeen: "1" });
  restoreBackup(target, backup);
  assert.deepEqual(Object.fromEntries(target.map), { watchlist: "{}", searchFilter: "movie", concernsTipSeen: "1" });
});

test("parseBackup refuses other files and drops unknown or non-text values", () => {
  assert.equal(parseBackup("not json"), null);
  assert.equal(parseBackup('{"app":"other","version":1,"savedAt":"x","data":{}}'), null);
  assert.equal(parseBackup('{"app":"parents-guide","version":2,"savedAt":"x","data":{}}'), null);
  const b = parseBackup('{"app":"parents-guide","version":1,"savedAt":"x","data":{"thumbs":"{}","evil":"1","watchlist":5}}');
  assert.deepEqual(b?.data, { thumbs: "{}" });
});
