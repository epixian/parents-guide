import { CATEGORIES, type CategoryId } from "../shared/categories.js";
import type { MediaKind } from "../shared/types.js";

// Categories the user marked as non-concern. Stored in localStorage so the
// choice persists across visits. The server never sees it.
const KEY = "pairents.hiddenCategories";

export function loadHidden(): Set<CategoryId> {
  try {
    const raw = localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    const known = new Set<string>(CATEGORIES.map((c) => c.id));
    return new Set(ids.filter((id): id is CategoryId => known.has(id)));
  } catch {
    return new Set();
  }
}

export function saveHidden(hidden: Set<CategoryId>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

export function visibleCategories(hidden: Set<CategoryId>) {
  return CATEGORIES.filter((c) => !hidden.has(c.id));
}

// Set when the visitor dismisses the "My concerns" tip, so it shows only once.
const TIP_KEY = "pairents.concernsTipSeen";

export function tipSeen(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTipSeen(): void {
  try {
    localStorage.setItem(TIP_KEY, "1");
  } catch {
    // Storage blocked: the tip shows again on the next visit.
  }
}

// Streaming services the user does not have (TMDB provider ids). Stored like
// the hidden categories. Empty means every service shows.
const PROVIDERS_KEY = "pairents.hiddenProviders";

export function loadHiddenProviders(): Set<number> {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown[]) : [];
    return new Set(ids.filter((id): id is number => Number.isInteger(id)));
  } catch {
    return new Set();
  }
}

export function saveHiddenProviders(hidden: Set<number>): void {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

// The user's watchlist and own thumbs up or down, per title id (a TV series,
// not a season). Stored in the browser only, like the choices above.
const WATCHLIST_KEY = "pairents.watchlist";
const THUMBS_KEY = "pairents.thumbs";

export type Thumb = "up" | "down";

function loadRecord<T>(key: string, valid: (v: unknown) => v is T): Record<string, T> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, T] => valid(e[1])));
  } catch {
    return {};
  }
}

function saveRecord(key: string, value: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

/** One watchlist title, with what the home page card needs. */
export interface WatchlistEntry {
  /** ISO time the user added it. */
  addedAt: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
}

const isEntry = (v: unknown): v is WatchlistEntry => {
  const e = v as WatchlistEntry | null;
  return typeof e?.addedAt === "string" && typeof e.title === "string" && ["movie", "tv", "book"].includes(e.kind);
};

/** Title id → entry. */
export const loadWatchlist = () => loadRecord(WATCHLIST_KEY, isEntry);
export const saveWatchlist = (list: Record<string, WatchlistEntry>) => saveRecord(WATCHLIST_KEY, list);

export const loadThumbs = () => loadRecord(THUMBS_KEY, (v): v is Thumb => v === "up" || v === "down");
export const saveThumbs = (thumbs: Record<string, Thumb>) => saveRecord(THUMBS_KEY, thumbs);
