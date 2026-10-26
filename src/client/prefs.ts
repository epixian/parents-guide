import { CATEGORIES, SCORE_MAX, SCORE_MIN, TREATMENTS, type CategoryId, type TreatmentId } from "../shared/categories.js";
import type { MediaKind } from "../shared/types.js";

// Keys before the rename to parents-guide (old name → new name). The copy runs
// once per browser, on the first page load. Remove it when old visitors are
// unlikely to come back.
const RENAMED_KEYS: Record<string, string> = {
  "pairents.hiddenCategories": "hiddenCategories",
  "pairents.concernsTipSeen": "concernsTipSeen",
  "pairents.hiddenProviders": "hiddenProviders",
  "pairents.watchlist": "watchlist",
  "pairents.thumbs": "thumbs",
  "pairents.notInterested": "notInterested",
  "pairents.searchFilter": "searchFilter",
};

/** Copy each old key to its new name (unless the new one is set), then remove the old key. */
export function migrateKeys(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  for (const [from, to] of Object.entries(RENAMED_KEYS)) {
    const value = storage.getItem(from);
    if (value === null) continue;
    if (storage.getItem(to) === null) storage.setItem(to, value);
    storage.removeItem(from);
  }
}

try {
  migrateKeys(localStorage);
} catch {
  // Storage blocked: nothing to copy.
}

// Categories the user marked as non-concern. Stored in localStorage so the
// choice persists across visits. The server never sees it.
const KEY = "hiddenCategories";

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

// Concern limits: the highest level the user accepts per topic, and the
// treatments to leave out. Browse applies them (see browse.ts, max. and hide.).
// Stored like the hidden categories.
const LIMITS_KEY = "concernLimits";

export interface ConcernLimits {
  max: Partial<Record<CategoryId, number>>;
  hide: Partial<Record<CategoryId, TreatmentId[]>>;
}

/** Read saved limits, keeping only known topics, levels, and treatments. */
export function parseLimits(raw: string | null): ConcernLimits {
  const limits: ConcernLimits = { max: {}, hide: {} };
  try {
    const data = JSON.parse(raw ?? "{}") as { max?: Record<string, unknown>; hide?: Record<string, unknown> };
    for (const c of CATEGORIES) {
      const max = data.max?.[c.id];
      if (Number.isInteger(max) && (max as number) >= SCORE_MIN && (max as number) < SCORE_MAX) limits.max[c.id] = max as number;
      const hide = data.hide?.[c.id];
      const ids = c.hasTreatment && Array.isArray(hide) ? TREATMENTS.filter((t) => t.id !== "not_present" && hide.includes(t.id)).map((t) => t.id) : [];
      if (ids.length) limits.hide[c.id] = ids;
    }
  } catch {
    // Unreadable: no limits.
  }
  return limits;
}

export function loadLimits(): ConcernLimits {
  try {
    return parseLimits(localStorage.getItem(LIMITS_KEY));
  } catch {
    return { max: {}, hide: {} };
  }
}

export function saveLimits(limits: ConcernLimits): void {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
  } catch {
    // Storage blocked: the limits last for this page view only.
  }
}

/** Browse query keys for the limits of the topics the user has not hidden. A hidden topic is not a concern. */
export function limitParams(limits: ConcernLimits, hidden: Set<CategoryId>): [string, string][] {
  return [
    ...Object.entries(limits.max).filter(([id]) => !hidden.has(id as CategoryId)).map(([id, n]): [string, string] => [`max.${id}`, String(n)]),
    ...Object.entries(limits.hide).filter(([id]) => !hidden.has(id as CategoryId)).map(([id, ids]): [string, string] => [`hide.${id}`, ids!.join(",")]),
  ];
}

// Set when the visitor dismisses the "My concerns" tip, so it shows only once.
const TIP_KEY = "concernsTipSeen";

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
const PROVIDERS_KEY = "hiddenProviders";

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
const WATCHLIST_KEY = "watchlist";
const THUMBS_KEY = "thumbs";

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

// Titles the user marked "Not interested": left out of the recommendations.
// Title id → ISO time. They do not change the thumbs. For the tag weights and
// the fit hint they count as a weak thumbs down (see markSignals).
const NOT_INTERESTED_KEY = "notInterested";

export const loadNotInterested = () => loadRecord(NOT_INTERESTED_KEY, (v): v is string => typeof v === "string");
export const saveNotInterested = (ids: Record<string, string>) => saveRecord(NOT_INTERESTED_KEY, ids);

// Set after this browser connected to Google Drive for the backup, cleared
// after "Delete backup" removes the access. Only this flag: the page cannot
// ask Google about the access without loading Google's script first.
const DRIVE_KEY = "driveBackup";

export function driveUsed(): boolean {
  try {
    return localStorage.getItem(DRIVE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDriveUsed(used: boolean): void {
  try {
    if (used) localStorage.setItem(DRIVE_KEY, "1");
    else localStorage.removeItem(DRIVE_KEY);
  } catch {
    // Storage blocked: Delete backup shows only until the page reloads.
  }
}
