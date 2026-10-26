// The browser's copy of GET /api/titles, kept in IndexedDB across visits, so
// a later visit asks only for the titles that changed (see titles.ts).
// localStorage is too small: the list is more than 3 MB.
//
// One record per title, so an update writes only the changed titles, and the
// tag in its own store. Each write is one transaction, so the tag always
// matches the titles.
//
// Every call fails quietly: with no IndexedDB (some private windows) or a
// blocked database, the app loads the whole list as before.

import type { IndexEntry } from "../shared/types.js";

export interface StoredTitles {
  /** The server's tag for this version (X-Titles-Tag). */
  tag: string;
  titles: IndexEntry[];
}

const DB = "parents-guide";
/** 1 was one "kv" store with the whole list in one record (never shipped). */
const VERSION = 2;
const TITLES = "titles";
const META = "meta";
/** Give up on a database that does not answer, for example one blocked by another tab. */
const TIMEOUT_MS = 3000;

let db: Promise<IDBDatabase | null> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS))]);
}

function open(): Promise<IDBDatabase | null> {
  db ??= withTimeout(
    (async () => {
      // Raise VERSION when the stores change. The upgrade starts again from empty
      // stores: the saved copy is only a cache, and the next sync loads the whole list.
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const conn = req.result;
        for (const name of [...conn.objectStoreNames]) conn.deleteObjectStore(name);
        conn.createObjectStore(TITLES, { keyPath: "id" });
        conn.createObjectStore(META);
      };
      const conn = await request(req);
      // Let a newer version in another tab upgrade; this tab then works without a saved copy.
      conn.onversionchange = () => {
        conn.close();
        db = Promise.resolve(null);
      };
      return conn;
    })().catch(() => null),
    null,
  );
  return db;
}

/** The saved copy, or null when there is none or it cannot be read. */
export async function readTitles(): Promise<StoredTitles | null> {
  try {
    const conn = await open();
    if (!conn) return null;
    const tx = conn.transaction([TITLES, META]);
    const read = Promise.all([request(tx.objectStore(META).get("tag")), request(tx.objectStore(TITLES).getAll())]);
    const [tag, titles] = await withTimeout(read, [undefined, []] as [unknown, IndexEntry[]]);
    return typeof tag === "string" && titles.length ? { tag, titles: titles as IndexEntry[] } : null;
  } catch {
    return null;
  }
}

/**
 * Write titles and the new tag in one transaction. replace: delete the old
 * copy first. False when the write failed or took too long; the saved copy is
 * then the one before it. Never throws.
 */
async function write(tag: string, titles: IndexEntry[], replace: boolean): Promise<boolean> {
  try {
    const conn = await open();
    if (!conn) return false;
    const tx = conn.transaction([TITLES, META], "readwrite");
    const store = tx.objectStore(TITLES);
    if (replace) store.clear();
    for (const t of titles) store.put(t);
    tx.objectStore(META).put(tag, "tag");
    return await withTimeout(done(tx).then(() => true), false);
  } catch {
    return false; // Quota or a closed database.
  }
}

/** Replace the saved copy with a whole list. */
export function writeTitles(value: StoredTitles): Promise<boolean> {
  return write(value.tag, value.titles, true);
}

/** Add the changed titles to the saved copy, with the new tag. Only after a write that worked: else the copy misses earlier changes. */
export function writeChanges(tag: string, changed: IndexEntry[]): Promise<boolean> {
  return write(tag, changed, false);
}

/**
 * Delete the saved copy and its database, for "Delete all data". Closes this
 * tab's connection first; other open tabs hold the delete until they close.
 */
export async function deleteTitles(): Promise<void> {
  const conn = await (db ?? Promise.resolve(null));
  conn?.close();
  db = Promise.resolve(null);
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(DB);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
      undefined,
    );
  } catch {
    // No IndexedDB: nothing to delete.
  }
}
