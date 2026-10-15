import { CATEGORIES, SCORE_MAX, SCORE_MIN, TREATMENTS, type CategoryId, type TreatmentId } from "../shared/categories.js";
import { THEME_TAGS, type ThemeTag } from "../shared/themes.js";
import type { BrowseResponse, BrowseSort, IndexEntry, MediaKind } from "../shared/types.js";
import { HttpError } from "./http.js";

// Browse filters, read from the query string. The client keeps the same
// query string in its URL, so a filtered list can be bookmarked or shared.
//
//   kind=movie                  movie | tv | book
//   q=star                      title contains this text
//   tag=friendship&tag=family   has every listed theme tag
//   max.violence=2              score at most 2
//   hide.lgbtq=approving        no listed treatment (repeat the key, or comma-separate)
//   sort=added                  added (newest first) | title | year (newest first)
//   offset=0&limit=24
//
// TV series use the highest score and every treatment across rated seasons,
// so a series passes a filter only when all its rated seasons pass.

export interface BrowseFilters {
  kind: MediaKind | null;
  q: string;
  tags: ThemeTag[];
  max: Partial<Record<CategoryId, number>>;
  hide: Partial<Record<CategoryId, TreatmentId[]>>;
  sort: BrowseSort;
  offset: number;
  limit: number;
}

export const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

const KINDS = new Set<string>(["movie", "tv", "book"]);
const SORTS = new Set<string>(["added", "title", "year"]);
const TAGS = new Set<string>(THEME_TAGS);
const CATEGORY_BY_ID = new Map<string, (typeof CATEGORIES)[number]>(CATEGORIES.map((c) => [c.id, c]));
const TREATMENT_IDS = new Set<string>(TREATMENTS.map((t) => t.id));

function intParam(name: string, value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  return n;
}

function category(key: string, prefix: string): (typeof CATEGORIES)[number] {
  const c = CATEGORY_BY_ID.get(key.slice(prefix.length));
  if (!c) throw new HttpError(400, `Unknown topic in ${key}`);
  return c;
}

/** Read and check the filters. Throws a 400 HttpError for a bad value. */
export function parseBrowseQuery(params: URLSearchParams): BrowseFilters {
  const kind = params.get("kind") || null;
  if (kind && !KINDS.has(kind)) throw new HttpError(400, "kind must be movie, tv, or book");
  const sort = params.get("sort") || "added";
  if (!SORTS.has(sort)) throw new HttpError(400, "sort must be added, title, or year");

  const tags = [...new Set(params.getAll("tag").filter(Boolean))];
  const unknownTag = tags.find((t) => !TAGS.has(t));
  if (unknownTag) throw new HttpError(400, `Unknown theme tag: ${unknownTag}`);

  const max: BrowseFilters["max"] = {};
  const hide: BrowseFilters["hide"] = {};
  for (const [key, value] of params) {
    if (key.startsWith("max.")) {
      const c = category(key, "max.");
      max[c.id] = intParam(key, value, SCORE_MIN, SCORE_MAX, SCORE_MAX);
    } else if (key.startsWith("hide.")) {
      const c = category(key, "hide.");
      if (!c.hasTreatment) throw new HttpError(400, `${c.id} has no treatment`);
      const ids = value.split(",").filter(Boolean);
      const bad = ids.find((t) => !TREATMENT_IDS.has(t) || t === "not_present");
      if (bad) throw new HttpError(400, `Unknown treatment in ${key}: ${bad}`);
      // A form sends one key per checkbox; a hand-written URL can use commas.
      if (ids.length) hide[c.id] = [...new Set([...(hide[c.id] ?? []), ...(ids as TreatmentId[])])];
    }
  }

  return {
    kind: kind as MediaKind | null,
    q: (params.get("q") ?? "").trim().slice(0, 100),
    tags: tags as ThemeTag[],
    max,
    hide,
    sort: sort as BrowseSort,
    offset: intParam("offset", params.get("offset") ?? undefined, 0, 1_000_000, 0),
    limit: intParam("limit", params.get("limit") ?? undefined, 1, MAX_LIMIT, DEFAULT_LIMIT),
  };
}

/** Lower case without accents, for title matching ("Amélie" matches "amelie"). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** First year in "1999" or "2008–2013"; 0 when unknown, so those sort last. */
const firstYear = (years: string | null) => Number(/\d{4}/.exec(years ?? "")?.[0] ?? 0);

function matches(t: IndexEntry, f: BrowseFilters, q: string): boolean {
  if (f.kind && t.kind !== f.kind) return false;
  if (q && !fold(t.title).includes(q)) return false;
  if (f.tags.some((tag) => !t.themeTags.includes(tag))) return false;
  for (const [id, limit] of Object.entries(f.max) as [CategoryId, number][]) {
    if ((t.scores[id] ?? 0) > limit) return false;
  }
  for (const [id, hidden] of Object.entries(f.hide) as [CategoryId, TreatmentId[]][]) {
    if ((t.treatments[id] ?? []).some((tr) => hidden.includes(tr))) return false;
  }
  return true;
}

const SORTERS: Record<BrowseSort, (a: IndexEntry, b: IndexEntry) => number> = {
  added: (a, b) => b.addedAt.localeCompare(a.addedAt),
  title: (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
  year: (a, b) => firstYear(b.years) - firstYear(a.years) || a.title.localeCompare(b.title),
};

/** Filter, sort, and page the titles. Tag counts cover every match, not only the current page. */
export function browseTitles(titles: IndexEntry[], f: BrowseFilters): BrowseResponse {
  const q = fold(f.q);
  const found = titles.filter((t) => matches(t, f, q)).sort(SORTERS[f.sort]);
  const counts = new Map<ThemeTag, number>();
  for (const t of found) for (const tag of t.themeTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return {
    total: found.length,
    offset: f.offset,
    items: found.slice(f.offset, f.offset + f.limit),
    tags: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count })),
  };
}
