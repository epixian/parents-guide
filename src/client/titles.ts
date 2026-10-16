// Browse and search suggestions run in the browser, on the full list of rated
// titles from GET /api/titles (about 60 KB gzipped per 1,000 titles). The list
// loads one time. Later uses ask the server for changes with the list's ETag,
// and the answer is an empty 304 until a title is added or changed.
//
// When the browser asks to save data, or the list does not load, the server
// filters instead (GET /api/browse and GET /api/suggest), with the same code
// (src/shared/browse.ts).

import { browseTitles, parseBrowseQuery, suggestTitles } from "../shared/browse.js";
import type { BrowseResponse, IndexEntry, Suggestion } from "../shared/types.js";
import { api } from "./api.js";

/** Use a loaded list for this long before asking the server for changes. */
const MAX_AGE_MS = 60_000;
const SUGGEST_LIMIT = 8;

let list: { at: number; titles: Promise<IndexEntry[]>; ready: boolean } | null = null;

/** True when the visitor turned on data saver (Chrome and Edge only; other browsers give no value). */
function saveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
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

/** True when suggestions can come from a loaded list, with no network wait. */
export function titlesReady(): boolean {
  return !!list?.ready && Date.now() - list.at <= MAX_AGE_MS && !saveData();
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

/** Rated titles for the search box as the visitor types. */
export async function suggest(q: string): Promise<Suggestion[]> {
  const titles = await load(MAX_AGE_MS)?.catch(() => null);
  return titles ? suggestTitles(titles, q, SUGGEST_LIMIT) : api.suggest(q);
}
