import { CATEGORIES, SCORE_MAX, SCORE_MIN, TREATMENTS, type CategoryId, type TreatmentId } from "./categories.js";
import { MOOD_SCALES, type MoodScale } from "./mood.js";
import { THEME_TAGS, type ThemeTag } from "./themes.js";
import type {
  BrowseResponse,
  BrowseSort,
  CatalogEntry,
  CatalogResponse,
  IndexEntry,
  MediaKind,
  Suggestion,
} from "./types.js";

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

/** True when the title streams on a service not in hidden. Books and titles with no services never do. */
export const onMyServices = (providers: number[] | undefined, hidden: Set<number>) => !!providers?.some((id) => !hidden.has(id));

function matches(t: IndexEntry, f: BrowseFilters, q: string): boolean {
  if (f.kinds.length && !f.kinds.includes(t.kind)) return false;
  if (q && !fold(t.title).includes(q)) return false;
  if (f.streaming && !onMyServices(t.providers, f.hiddenServices)) return false;
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

/** Roman numerals as numbers, so "rocky 2" matches "Rocky II". Not "i": it is also a word. */
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

/** Title or query text for suggestions: folded words, "&" as "and", and roman numerals as numbers. */
function tokens(s: string): string[] {
  const text = words(s.replace(/&/g, " and "));
  return text ? text.split(" ").map((w) => ROMAN[w] ?? w) : [];
}

interface Matchable {
  /** The tokens joined with spaces. */
  text: string;
  tokens: string[];
  /** The tokens with no spaces, so "spiderman" matches "Spider-Man". */
  compact: string;
  /** Where each token starts in compact. */
  starts: number[];
}

function matchable(s: string): Matchable {
  const list = tokens(s);
  const starts: number[] = [];
  let at = 0;
  for (const t of list) {
    starts.push(at);
    at += t.length;
  }
  return { text: list.join(" "), tokens: list, compact: list.join(""), starts };
}

/** matchable() of each title, kept per entry: the catalog has about 10,000 titles to match on each keystroke. */
const matchables = new WeakMap<object, Matchable>();
function matchableOf(entry: { title: string }): Matchable {
  let m = matchables.get(entry);
  if (!m) matchables.set(entry, (m = matchable(entry.title)));
  return m;
}

/**
 * Edit distance with swapped neighbors as one edit (optimal string alignment),
 * or max + 1 when it is more than max.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1; // Every later row is at least as large.
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** True when the typed word is a title word, or its start, with a small typo: 1 letter in 4-7 letters, 2 in more. */
function nearWord(typed: string, word: string): boolean {
  if (word.startsWith(typed)) return true;
  // Short words have too many neighbors. A typo in the first letter is rare, and the check is much faster.
  if (typed.length < 4 || typed[0] !== word[0]) return false;
  const max = typed.length >= 8 ? 2 : 1;
  // The whole word ("fablemans": "fabelmans"), or its start while the visitor types ("oppenhiem": "oppenheimer").
  if (editDistance(typed, word, max) <= max) return true;
  return word.length > typed.length && editDistance(typed, word.slice(0, typed.length), max) <= max;
}

/**
 * How well a title matches the query, from best to worst, or null for no match:
 * 0 the same, 1 starts with it, 2 a word starts with it, 3 contains it (each
 * with or without spaces), 4 every typed word starts a title word, in any
 * order, 5 the same with small typos (only when fuzzy is true).
 */
function suggestRank(title: Matchable, q: Matchable, fuzzy: boolean): number | null {
  const { compact } = title;
  if (compact === q.compact) return 0;
  if (compact.startsWith(q.compact)) return 1;
  if (title.starts.some((at) => compact.startsWith(q.compact, at))) return 2;
  if (compact.includes(q.compact)) return 3;
  if (q.tokens.length > 1 && q.tokens.every((typed) => title.tokens.some((w) => w.startsWith(typed)))) return 4;
  if (fuzzy && q.tokens.every((typed) => title.tokens.some((w) => nearWord(typed, w)))) return 5;
  return null;
}

/** The rows of GET /api/catalog as entries. */
export function catalogEntries(res: CatalogResponse): CatalogEntry[] {
  return (["movie", "tv"] as const).flatMap((kind) =>
    (res[kind] ?? []).map(([id, title, year]) => ({ id: `tmdb-${kind}-${id}`, kind, title, year })),
  );
}

/**
 * Titles for the search box as the visitor types: best matches first (see
 * suggestRank), then shorter titles. Popular titles from the catalog fill in
 * where no rated title matches as well; a rated title wins a tie, and a
 * catalog title that is already rated is left out.
 */
export function suggestTitles(
  titles: readonly IndexEntry[],
  q: string,
  limit: number,
  catalog: readonly CatalogEntry[] = [],
): Suggestion[] {
  const query = matchable(q);
  if (!query.compact) return [];
  const ratedIds = new Set(titles.map((t) => t.id));
  const found: { s: Suggestion; rank: number; length: number }[] = [];
  const search = (fuzzy: boolean) => {
    const add = (entry: IndexEntry | CatalogEntry, toSuggestion: () => Suggestion) => {
      const title = matchableOf(entry);
      const rank = suggestRank(title, query, fuzzy);
      if (rank !== null && (!fuzzy || rank === 5)) found.push({ s: toSuggestion(), rank, length: title.text.length });
    };
    for (const t of titles) {
      add(t, () => ({ id: t.id, kind: t.kind, title: t.title, years: t.years, imageUrl: t.imageUrl, rated: true }));
    }
    for (const c of catalog) {
      if (ratedIds.has(c.id)) continue;
      add(c, () => ({ id: c.id, kind: c.kind, title: c.title, years: c.year?.toString() ?? null, imageUrl: null, rated: false }));
    }
  };
  search(false);
  // Typos only fill a short list: the check is slower, and its matches are the least sure.
  if (found.length < limit) search(true);
  return found
    .sort(
      (a, b) =>
        a.rank - b.rank || Number(b.s.rated) - Number(a.s.rated) || a.length - b.length || a.s.title.localeCompare(b.s.title),
    )
    .slice(0, limit)
    .map(({ s }) => s);
}
