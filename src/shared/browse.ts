import { CATEGORIES, SCORE_MAX, SCORE_MIN, TREATMENTS, type CategoryId, type TreatmentId } from "./categories.js";
import { MOOD_SCALES, type MoodScale } from "./mood.js";
import { THEME_TAGS, type ThemeTag } from "./themes.js";
import type { BrowseResponse, BrowseSort, IndexEntry, MediaKind, Suggestion } from "./types.js";

// Browse filters, read from the query string. The client keeps the same
// query string in its URL, so a filtered list can be bookmarked or shared.
// The client filters the list from GET /api/titles with this code. The server
// uses it too, for GET /api/browse and GET /api/suggest (the fallback when the
// browser asks to save data).
//
//   kind=movie&kind=tv          movie | tv | book (repeat the key, or comma-separate; none = all)
//   q=star                      title contains this text
//   streaming=mine              streams on a service the user has (movies and TV only)
//   hideService=8,15            services the user does not have (TMDB ids; repeat the key, or comma-separate).
//                               The client adds it from "My services" for each request; it is not in the page URL.
//   tag=friendship&tag=family   has every listed theme tag
//   tone=4,5&depth=3            mood level is one of these (1-5; repeat the key, or comma-separate)
//   max.violence=2              score at most 2 (max. and hide. come from the saved concern limits;
//                               the client adds them for each request, not in the page URL)
//   hide.lgbtq=approving        no listed treatment (repeat the key, or comma-separate)
//   sort=added                  added (newest first) | title | year (newest first) | score (user score, highest first)
//                               | random (the same order for the same seed, so paging works)
//   seed=12345                  for sort=random: 0 to 2^31-1
//   offset=0&limit=24
//
// TV series use the highest score and every treatment across rated seasons,
// so a series passes a filter only when all its rated seasons pass.

export interface BrowseFilters {
  kinds: MediaKind[];
  q: string;
  /** Only titles that stream on a service not in hiddenServices. */
  streaming: boolean;
  hiddenServices: Set<number>;
  tags: ThemeTag[];
  /** Allowed levels per mood scale. A title with no mood fails a scale with levels. */
  mood: Partial<Record<MoodScale, number[]>>;
  max: Partial<Record<CategoryId, number>>;
  hide: Partial<Record<CategoryId, TreatmentId[]>>;
  sort: BrowseSort;
  /** Order for sort=random. */
  seed: number;
  offset: number;
  limit: number;
}

/** A bad filter value. The server answers 400 with the message. */
export class BrowseQueryError extends Error {}

export const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

const KINDS = new Set<string>(["movie", "tv", "book"]);
const SORTS = new Set<string>(["added", "title", "year", "score", "random"]);
const TAGS = new Set<string>(THEME_TAGS);
const CATEGORY_BY_ID = new Map<string, (typeof CATEGORIES)[number]>(CATEGORIES.map((c) => [c.id, c]));
const TREATMENT_IDS = new Set<string>(TREATMENTS.map((t) => t.id));

function intParam(name: string, value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new BrowseQueryError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function category(key: string, prefix: string): (typeof CATEGORIES)[number] {
  const c = CATEGORY_BY_ID.get(key.slice(prefix.length));
  if (!c) throw new BrowseQueryError(`Unknown topic in ${key}`);
  return c;
}

/** Read and check the filters. Throws a BrowseQueryError for a bad value. */
export function parseBrowseQuery(params: URLSearchParams): BrowseFilters {
  const kinds = [...new Set(params.getAll("kind").flatMap((v) => v.split(",")).filter(Boolean))];
  if (kinds.some((k) => !KINDS.has(k))) throw new BrowseQueryError("kind must be movie, tv, or book");
  const streaming = params.get("streaming") || "";
  if (streaming && streaming !== "mine") throw new BrowseQueryError("streaming must be mine");
  const hiddenServices = params.getAll("hideService").flatMap((v) => v.split(",")).filter(Boolean).map(Number);
  if (hiddenServices.some((id) => !Number.isInteger(id))) throw new BrowseQueryError("hideService must be service ids");
  const sort = params.get("sort") || "added";
  if (!SORTS.has(sort)) throw new BrowseQueryError("sort must be added, title, year, score, or random");

  const tags = [...new Set(params.getAll("tag").filter(Boolean))];
  const unknownTag = tags.find((t) => !TAGS.has(t));
  if (unknownTag) throw new BrowseQueryError(`Unknown theme tag: ${unknownTag}`);

  const mood: BrowseFilters["mood"] = {};
  for (const { id } of MOOD_SCALES) {
    const levels = [...new Set(params.getAll(id).flatMap((v) => v.split(",")).filter(Boolean).map(Number))];
    if (levels.some((n) => !Number.isInteger(n) || n < 1 || n > 5)) throw new BrowseQueryError(`${id} levels must be 1 to 5`);
    if (levels.length) mood[id] = levels;
  }

  const max: BrowseFilters["max"] = {};
  const hide: BrowseFilters["hide"] = {};
  for (const [key, value] of params) {
    if (key.startsWith("max.")) {
      const c = category(key, "max.");
      max[c.id] = intParam(key, value, SCORE_MIN, SCORE_MAX, SCORE_MAX);
    } else if (key.startsWith("hide.")) {
      const c = category(key, "hide.");
      if (!c.hasTreatment) throw new BrowseQueryError(`${c.id} has no treatment`);
      const ids = value.split(",").filter(Boolean);
      const bad = ids.find((t) => !TREATMENT_IDS.has(t) || t === "not_present");
      if (bad) throw new BrowseQueryError(`Unknown treatment in ${key}: ${bad}`);
      // A form sends one key per checkbox; a hand-written URL can use commas.
      if (ids.length) hide[c.id] = [...new Set([...(hide[c.id] ?? []), ...(ids as TreatmentId[])])];
    }
  }

  return {
    kinds: kinds as MediaKind[],
    q: (params.get("q") ?? "").trim().slice(0, 100),
    streaming: !!streaming,
    hiddenServices: new Set(hiddenServices),
    tags: tags as ThemeTag[],
    mood,
    max,
    hide,
    sort: sort as BrowseSort,
    seed: intParam("seed", params.get("seed") ?? undefined, 0, 2 ** 31 - 1, 0),
    offset: intParam("offset", params.get("offset") ?? undefined, 0, 1_000_000, 0),
    limit: intParam("limit", params.get("limit") ?? undefined, 1, MAX_LIMIT, DEFAULT_LIMIT),
  };
}

/** Lower case without accents, for title matching ("Amélie" matches "amelie"). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** First year in "1999" or "2008–2013"; 0 when unknown, so those sort last. */
const firstYear = (years: string | null) => Number(/\d{4}/.exec(years ?? "")?.[0] ?? 0);

/** True when the title is within every level limit and has none of the treatments to leave out. */
export function withinLimits(t: IndexEntry, f: Pick<BrowseFilters, "max" | "hide">): boolean {
  for (const [id, limit] of Object.entries(f.max) as [CategoryId, number][]) {
    if ((t.scores[id] ?? 0) > limit) return false;
  }
  for (const [id, hidden] of Object.entries(f.hide) as [CategoryId, TreatmentId[]][]) {
    if ((t.treatments[id] ?? []).some((tr) => hidden.includes(tr))) return false;
  }
  return true;
}

function matches(t: IndexEntry, f: BrowseFilters, q: string): boolean {
  if (f.kinds.length && !f.kinds.includes(t.kind)) return false;
  if (q && !fold(t.title).includes(q)) return false;
  if (f.streaming && !t.providers?.some((id) => !f.hiddenServices.has(id))) return false;
  if (f.tags.some((tag) => !t.themeTags.includes(tag))) return false;
  for (const [id, levels] of Object.entries(f.mood) as [MoodScale, number[]][]) {
    if (!t.mood || !levels.includes(t.mood[id])) return false;
  }
  return withinLimits(t, f);
}

/** FNV-1a hash of the text: a fixed, well-mixed number for each seed and id. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Random order for a seed: sort by a hash of the seed and the id. */
function shuffled(titles: IndexEntry[], seed: number): IndexEntry[] {
  return titles
    .map((t) => ({ t, key: hash(`${seed}:${t.id}`) }))
    .sort((a, b) => a.key - b.key || a.t.id.localeCompare(b.t.id))
    .map(({ t }) => t);
}

const SORTERS: Record<Exclude<BrowseSort, "random">, (a: IndexEntry, b: IndexEntry) => number> = {
  added: (a, b) => b.addedAt.localeCompare(a.addedAt),
  title: (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
  year: (a, b) => firstYear(b.years) - firstYear(a.years) || a.title.localeCompare(b.title),
  // Titles with no score come last.
  score: (a, b) => (b.userScore ?? -1) - (a.userScore ?? -1) || a.title.localeCompare(b.title),
};

/** Filter, sort, and page the titles. Tag counts cover every match, not only the current page. */
export function browseTitles(titles: readonly IndexEntry[], f: BrowseFilters): BrowseResponse {
  const q = fold(f.q);
  const matched = titles.filter((t) => matches(t, f, q));
  const found = f.sort === "random" ? shuffled(matched, f.seed) : matched.sort(SORTERS[f.sort]);
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

/** Folded, with punctuation as spaces, so "spider man" matches "Spider-Man". */
const words = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** 0 exact, 1 starts with q, 2 a word starts with q, 3 contains q, null no match. */
function suggestRank(title: string, q: string): number | null {
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (` ${title}`.includes(` ${q}`)) return 2;
  if (title.includes(q)) return 3;
  return null;
}

/** Rated titles for the search box as the visitor types: best matches first, then shorter titles. */
export function suggestTitles(titles: readonly IndexEntry[], q: string, limit: number): Suggestion[] {
  const query = words(q);
  if (!query) return [];
  return titles
    .flatMap((t) => {
      const title = words(t.title);
      const rank = suggestRank(title, query);
      return rank === null ? [] : [{ t, rank, length: title.length }];
    })
    .sort((a, b) => a.rank - b.rank || a.length - b.length || a.t.title.localeCompare(b.t.title))
    .slice(0, limit)
    .map(({ t }) => ({ id: t.id, kind: t.kind, title: t.title, years: t.years, imageUrl: t.imageUrl }));
}
