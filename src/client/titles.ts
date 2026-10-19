// Browse and search suggestions run in the browser, on the full list of rated
// titles from GET /api/titles (about 60 KB gzipped per 1,000 titles). The list
// loads one time. Later uses ask the server for changes with the list's ETag,
// and the answer is an empty 304 until a title is added or changed.
//
// Suggestions also match about 10,000 popular movies and TV series from
// GET /api/catalog (about 125 KB compressed; the server rebuilds it each week).
// It loads only when the search box gets focus, so visitors who never search
// do not pay for it.
//
// When the browser asks to save data, or the list does not load, the server
// filters instead (GET /api/browse and GET /api/suggest), with the same code
// (src/shared/browse.ts).

import { browseTitles, catalogEntries, parseBrowseQuery, suggestTitles } from "../shared/browse.js";
import type { BrowseResponse, CatalogEntry, IndexEntry, Suggestion } from "../shared/types.js";
import { api } from "./api.js";

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

/** The list, loaded or checked again when older than maxAge. Null when the server must filter. */
function load(maxAge: number): Promise<IndexEntry[]> | null {
  if (saveData()) return null;
  if (!list || Date.now() - list.at > maxAge) {
    const entry = { at: Date.now(), titles: api.titles(), ready: false };
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

/** The catalog list, or null when the server must filter. retry: load again after a failure. */
function loadCatalog(retry = false): Promise<CatalogEntry[]> | null {
  if (saveData()) return null;
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

/** Start to load what the search suggestions need, when the search box gets focus. */
export function preloadSearch(): void {
  preloadTitles();
  void loadCatalog(true);
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
  return !!list?.ready && Date.now() - list.at <= MAX_AGE_MS && !saveData() && !!catalog?.settled;
}

/**
 * Rated titles that match the browse query (see src/shared/browse.ts).
 * fresh: ask the server for changes first, for example when a page opens.
 * Throws a BrowseQueryError for a bad filter value.
 */
export async function browse(query: string, fresh = false): Promise<BrowseResponse> {
  const filters = parseBrowseQuery(new URLSearchParams(query));
  const titles = await load(fresh ? 0 : MAX_AGE_MS)?.catch(() => null);
  return titles ? browseTitles(titles, filters) : api.browse(query);
}

/** Every rated title by id, or null when the list does not load (or with data saver). */
export async function titlesById(): Promise<Map<string, IndexEntry> | null> {
  const titles = await load(MAX_AGE_MS)?.catch(() => null);
  return titles ? new Map(titles.map((t) => [t.id, t])) : null;
}

/**
 * Rated and popular titles for the search box as the visitor types. Waits for
 * both lists, so the suggestions for one text are drawn only once.
 */
export async function suggest(q: string): Promise<Suggestion[]> {
  const [titles, popular] = await Promise.all([load(MAX_AGE_MS)?.catch(() => null), loadCatalog()]);
  return titles ? suggestTitles(titles, q, SUGGEST_LIMIT, popular ?? []) : api.suggest(q);
}
