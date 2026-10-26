// Browse and search suggestions run in the browser, on the full list of rated
// titles from GET /api/titles (about 85 KB gzipped per 1,000 titles). The
// browser keeps the list in IndexedDB (titleStore.ts) with the server's tag
// for that version. Later uses, also on a later visit, ask only for the titles
// that changed since that tag (GET /api/titles/changes), and add them to the
// copy. Tags stay valid after a server restart. The server answers "reset",
// and the browser loads the whole list again, only for a bad tag or when most
// titles changed (see TitleChangeLog in src/server/titleChanges.ts).
//
// Suggestions also match about 10,000 popular movies and TV series from
// GET /api/catalog (about 125 KB compressed; the server rebuilds it each week).
// It loads only when the search box gets focus, so visitors who never search
// do not pay for it.
//
// Browse and suggestions always run in the browser, also when the browser
// asks to save data: then the lists load only when the visitor uses the search
// box or Browse. So the concern limits, the user's services, and the typed
// text never go to the server.

import { browseTitles, catalogEntries, parseBrowseQuery, suggestTitles } from "../shared/browse.js";
import type { BrowseResponse, CatalogEntry, IndexEntry, Suggestion } from "../shared/types.js";
import { api } from "./api.js";
import { readTitles, writeChanges, writeTitles, type StoredTitles } from "./titleStore.js";

/** Use a loaded list for this long before asking the server for changes. */
const MAX_AGE_MS = 60_000;
const SUGGEST_LIMIT = 8;

let list: { at: number; titles: Promise<IndexEntry[]>; ready: boolean } | null = null;

type Connection = { saveData?: boolean; effectiveType?: string };
const connection = () => (navigator as Navigator & { connection?: Connection }).connection;

/** True when the visitor turned on data saver (Chrome and Edge only; other browsers give no value). */
function saveData(): boolean {
  return connection()?.saveData === true;
}

/** The newest copy of the list in this page, with its tag. */
let current: StoredTitles | null = null;
/** The saved copy from IndexedDB, read once per page. */
let stored: Promise<StoredTitles | null> | null = null;
/** False after a failed write: IndexedDB then has an older copy than current, so the next write replaces it all. */
let storeInSync = true;

/** Save current: only the changes when the saved copy is one step behind, else the whole list. */
function save(changed: IndexEntry[] | null): void {
  if (!current) return;
  const write = changed && storeInSync ? writeChanges(current.tag, changed) : writeTitles(current);
  storeInSync = false; // Until the write ends; a sync meanwhile replaces it all.
  void write.then((ok) => (storeInSync = ok));
}

/** The copy with the changed titles: replaced in place, new ones at the end. Unchanged entries stay the same objects. */
export function applyChanges(base: StoredTitles, tag: string, changed: IndexEntry[]): StoredTitles {
  if (!changed.length) return { tag, titles: base.titles };
  const byId = new Map(changed.map((t) => [t.id, t]));
  const titles = base.titles.map((t) => {
    const next = byId.get(t.id);
    if (next) byId.delete(t.id);
    return next ?? t;
  });
  return { tag, titles: [...titles, ...byId.values()] };
}

/**
 * The current list: the copy in this page or in IndexedDB plus the changes
 * since it, or the whole list when there is no copy or the server says reset.
 * When the server cannot be reached, a saved copy is used as it is.
 */
async function sync(): Promise<IndexEntry[]> {
  const base = current ?? (await (stored ??= readTitles()));
  if (base) {
    try {
      const res = await api.titleChanges(base.tag);
      if (!("reset" in res)) {
        current = applyChanges(base, res.tag, res.changed);
        if (current.tag !== base.tag) save(res.changed);
        return current.titles;
      }
    } catch {
      current = base;
      return base.titles;
    }
  }
  const { tag, titles } = await api.titles();
  current = tag ? { tag, titles } : null;
  save(null);
  return titles;
}

/**
 * The list, loaded or checked again when older than maxAge. Null when the
 * server must filter. always: load it also when the browser asks to save data.
 */
function load(maxAge: number, always = false): Promise<IndexEntry[]> | null {
  if (saveData() && !always) return null;
  if (!list || Date.now() - list.at > maxAge) {
    const entry = { at: Date.now(), titles: sync(), ready: false };
    list = entry;
    entry.titles.then(
      () => (entry.ready = true),
      // Try again on the next use.
      () => list === entry && (list = null),
    );
  }
  return list.titles;
}

/** Start to load the list, for example when the search box gets focus. */
export function preloadTitles(): void {
  void load(MAX_AGE_MS)?.catch(() => {});
}

/** The catalog list, loaded once per visit. Empty when it does not load. */
let catalog: { titles: Promise<CatalogEntry[]>; settled: boolean; failed: boolean } | null = null;

/**
 * The catalog list, or null with data saver unless always is set.
 * retry: load again after a failure.
 */
function loadCatalog(retry = false, always = false): Promise<CatalogEntry[]> | null {
  if (saveData() && !always) return null;
  if (!catalog || (retry && catalog.failed)) {
    const entry = { settled: false, failed: false, titles: Promise.resolve<CatalogEntry[]>([]) };
    entry.titles = api
      .catalog()
      .then(catalogEntries, () => [] as CatalogEntry[])
      .then((titles) => {
        // Empty also before the server's first build: try again on the next focus.
        entry.failed = !titles.length;
        return titles;
      })
      .finally(() => (entry.settled = true));
    catalog = entry;
  }
  return catalog.titles;
}

/** Start to load what the search suggestions need, when the search box gets focus. Also with data saver: the visitor is about to search. */
export function preloadSearch(): void {
  void load(MAX_AGE_MS, true)?.catch(() => {});
  void loadCatalog(true, true);
}

/**
 * Load the list when the browser is idle, so the first search or browse needs
 * no wait. Called once when the app starts, on any page. Not on a slow
 * connection (Chrome and Edge only); the search box still loads it on focus.
 */
export function prefetchTitles(): void {
  if (/2g|3g/.test(connection()?.effectiveType ?? "")) return;
  if ("requestIdleCallback" in window) requestIdleCallback(preloadTitles, { timeout: 5000 });
  else setTimeout(preloadTitles, 2000); // Safari
}

/** True when suggestions can come from loaded lists, with no network wait. */
export function titlesReady(): boolean {
  return !!list?.ready && Date.now() - list.at <= MAX_AGE_MS && !!catalog?.settled;
}

/**
 * Rated titles that match the browse query (see src/shared/browse.ts), always
 * from the list in the browser, also with data saver: the query has the user's
 * concern limits and services, which must not go to the server.
 * fresh: ask the server for changes first, for example when a page opens.
 * Throws a BrowseQueryError for a bad filter value, or when the list does not load.
 */
export async function browse(query: string, fresh = false): Promise<BrowseResponse> {
  const filters = parseBrowseQuery(new URLSearchParams(query));
  return browseTitles(await load(fresh ? 0 : MAX_AGE_MS, true)!, filters);
}

/** The map of each list version, and the list of each map: the same objects until the list changes. */
const mapOfList = new WeakMap<readonly IndexEntry[], Map<string, IndexEntry>>();
const listOfMap = new WeakMap<Map<string, IndexEntry>, readonly IndexEntry[]>();

/** Every rated title by id, or null when the list does not load (or with data saver). Callers must not change the map. */
export async function titlesById(): Promise<Map<string, IndexEntry> | null> {
  const titles = await load(MAX_AGE_MS)?.catch(() => null);
  if (!titles) return null;
  let map = mapOfList.get(titles);
  if (!map) {
    map = new Map(titles.map((t) => [t.id, t]));
    mapOfList.set(titles, map);
    listOfMap.set(map, titles);
  }
  return map;
}

/**
 * The list behind a map from titlesById: the same array until the list
 * changes, so the taste model keeps its work (see prepare in
 * src/shared/taste.ts).
 */
export function titleList(index: Map<string, IndexEntry>): readonly IndexEntry[] {
  return listOfMap.get(index) ?? [...index.values()];
}

/**
 * Rated and popular titles for the search box as the visitor types, always in
 * the browser. Waits for both lists, so the suggestions for one text are drawn
 * only once. A list that does not load gives no suggestions of its own.
 */
export async function suggest(q: string): Promise<Suggestion[]> {
  const [titles, popular] = await Promise.all([load(MAX_AGE_MS, true)!.catch(() => null), loadCatalog(false, true)]);
  return suggestTitles(titles ?? [], q, SUGGEST_LIMIT, popular ?? []);
}
