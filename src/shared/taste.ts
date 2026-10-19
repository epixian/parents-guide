// The user's taste, from their marks: thumbs up, thumbs down, and "Not
// interested". Runs in the browser; the marks never leave it.

import type { ThemeTag } from "./themes.js";
import type { IndexEntry } from "./types.js";

export type Thumbs = Readonly<Record<string, "up" | "down">>;

/** Weight of a "Not interested" title: a weaker no than a thumbs down. */
export const NOT_INTERESTED_WEIGHT = 0.5;

/**
 * Each marked title's signal: 1 liked, -1 disliked, -NOT_INTERESTED_WEIGHT
 * not interested. A thumb wins over "Not interested".
 */
export function markSignals(thumbs: Thumbs, notInterested: Readonly<Record<string, unknown>> = {}): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of Object.keys(notInterested)) out.set(id, -NOT_INTERESTED_WEIGHT);
  for (const [id, thumb] of Object.entries(thumbs)) out.set(id, thumb === "up" ? 1 : -1);
  return out;
}

/** Each tag's weight: the sum of the signals of the marked titles with it. Titles not in the catalog add nothing. */
export function tagWeights(
  signals: ReadonlyMap<string, number>,
  tagsOf: (id: string) => readonly ThemeTag[] | undefined,
): Map<ThemeTag, number> {
  const weight = new Map<ThemeTag, number>();
  for (const [id, n] of signals) {
    for (const tag of new Set(tagsOf(id) ?? [])) weight.set(tag, (weight.get(tag) ?? 0) + n);
  }
  return weight;
}

// ---------- Fit of one title ----------

/** Marked titles in the catalog needed before a fit shows. */
export const MIN_MARKED = 6;
/** Share of the marked titles the self-check must predict correctly (see fitFor). */
export const MIN_SELF_CHECK = 0.75;
/** Lowest fit score that counts as a strong match. */
export const MIN_FIT = 0.35;
/** A strong match must also be in this top share of the catalog's fit scores. */
export const TOP_SHARE = 0.05;
/** Marked titles that vote on a fit: the most similar ones. */
export const NEIGHBORS = 5;
/**
 * Parts of the similarity: genre counts most, then theme tags, then mood.
 * Genres keep a cartoon comedy apart from a crime thriller with the same
 * tags. Most titles for children have a similar mood, so mood alone says
 * little. A part that one of the titles has no data for is left out, and the
 * other parts share its weight.
 */
const GENRE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const MOOD_WEIGHT = 1;
/** Mood distance (on the 1-5 scales) at which two moods have no similarity. */
const MOOD_FAR = 2;

/** The fields of a title that the taste model reads. The worker gets only these (see src/client/tasteWorker.ts). */
export type TasteTitle = Pick<IndexEntry, "id" | "themeTags" | "genres" | "mood">;

export interface Fit<T extends TasteTitle = IndexEntry> {
  /**
   * -1 to 1: the sum of the signals of the NEIGHBORS most similar marked
   * titles, times their similarity, divided by NEIGHBORS. Near likes give a
   * high score; far likes give a low score.
   */
  score: number;
  /** Liked titles among the near ones, most similar first. */
  likedNear: T[];
}

/**
 * A set of theme tags or genres for the similarity: the keys as numbers in
 * order, with the weight (rarity squared, see rarityOf) of each, and the sum
 * of the weights. Numbers in order make a compare a merge of two short lists.
 */
interface KeySet {
  keys: Int32Array;
  weights: Float64Array;
  sum: number;
}

/** A title's parts for the similarity. Made once per catalog (see prepare). */
interface Features {
  tags: KeySet;
  genres: KeySet;
  mood?: IndexEntry["mood"];
}

interface Marked<T extends TasteTitle> {
  t: T;
  f: Features;
  signal: number;
}

/** Rarity of each key in the catalog: one that most titles have says little. */
function rarityOf<K>(catalog: readonly TasteTitle[], keys: (t: TasteTitle) => readonly K[]): (key: K) => number {
  const count = new Map<K, number>();
  for (const t of catalog) for (const key of new Set(keys(t))) count.set(key, (count.get(key) ?? 0) + 1);
  return (key) => Math.log(1 + catalog.length / (count.get(key) ?? 1));
}

/** number: gives each key a number, the same for the same key. */
function keySet<K>(keys: readonly K[], rare: (key: K) => number, number: (key: K) => number): KeySet {
  const unique = [...new Set(keys)].map((key) => ({ n: number(key), w: rare(key) ** 2 })).sort((a, b) => a.n - b.n);
  return {
    keys: Int32Array.from(unique, (u) => u.n),
    weights: Float64Array.from(unique, (u) => u.w),
    sum: unique.reduce((sum, u) => sum + u.w, 0),
  };
}

/** Work kept per catalog array: the features of its titles, and the model for the last marks. */
interface Prepared<T extends TasteTitle> {
  byId: Map<string, T>;
  features: (t: TasteTitle) => Features;
  last: { key: string; model: TasteModel<T> | null } | null;
}

/**
 * Kept while the catalog array lives. The browser keeps the same array until
 * the title list changes (see titleList in src/client/titles.ts), so the
 * features are made once, and the scores once per change of the marks.
 * Callers must not change the array or its entries.
 */
const prepared = new WeakMap<readonly TasteTitle[], Prepared<TasteTitle>>();

function prepare<T extends TasteTitle>(catalog: readonly T[]): Prepared<T> {
  let p = prepared.get(catalog) as Prepared<T> | undefined;
  if (p) return p;
  const rareTag = rarityOf(catalog, (t) => t.themeTags);
  const rareGenre = rarityOf(catalog, (t) => t.genres ?? []);
  const numbers = new Map<string, number>();
  const number = (key: string) => {
    let n = numbers.get(key);
    if (n === undefined) numbers.set(key, (n = numbers.size));
    return n;
  };
  const cache = new Map<TasteTitle, Features>();
  const features = (t: TasteTitle) => {
    let f = cache.get(t);
    if (!f) {
      f = {
        tags: keySet(t.themeTags, rareTag, (tag) => number(`t:${tag}`)),
        genres: keySet(t.genres ?? [], rareGenre, (genre) => number(`g:${genre}`)),
        mood: t.mood,
      };
      cache.set(t, f);
    }
    return f;
  };
  p = { byId: new Map(catalog.map((t) => [t.id, t])), features, last: null };
  prepared.set(catalog, p as Prepared<TasteTitle>);
  return p;
}

/** Cosine similarity of two weighted sets (see KeySet). 0 when either is empty. */
function cosine(a: KeySet, b: KeySet): number {
  if (!a.sum || !b.sum) return 0;
  let shared = 0;
  let i = 0;
  let j = 0;
  while (i < a.keys.length && j < b.keys.length) {
    const d = a.keys[i]! - b.keys[j]!;
    if (d === 0) {
      shared += a.weights[i]!;
      i++;
      j++;
    } else if (d < 0) i++;
    else j++;
  }
  return shared / Math.sqrt(a.sum * b.sum);
}

/**
 * Similarity of two titles, 0 to 1: the genre and tag similarity (see cosine)
 * and the mood closeness, by GENRE_WEIGHT, TAG_WEIGHT, and MOOD_WEIGHT.
 * Genres only when both titles have them (books do not); mood the same.
 */
function similarity(a: Features, b: Features): number {
  let sum = TAG_WEIGHT * cosine(a.tags, b.tags);
  let weight = TAG_WEIGHT;
  if (a.genres.keys.length && b.genres.keys.length) {
    sum += GENRE_WEIGHT * cosine(a.genres, b.genres);
    weight += GENRE_WEIGHT;
  }
  if (a.mood && b.mood) {
    const d = Math.hypot(a.mood.tone - b.mood.tone, a.mood.feeling - b.mood.feeling, a.mood.depth - b.mood.depth);
    sum += MOOD_WEIGHT * Math.max(0, 1 - d / MOOD_FAR);
    weight += MOOD_WEIGHT;
  }
  return sum / weight;
}

/** The fit score (see Fit) and the marked titles that vote on it, most similar first. */
function predict<T extends TasteTitle>(t: TasteTitle, f: Features, marked: readonly Marked<T>[]) {
  // The NEIGHBORS most similar, kept in order as they come: no sort of all marks per title.
  // Equal similarities keep the order of the marks.
  const near: (Marked<T> & { sim: number })[] = [];
  for (const m of marked) {
    if (m.t.id === t.id) continue;
    const sim = similarity(f, m.f);
    if (sim <= 0 || (near.length === NEIGHBORS && sim <= near[NEIGHBORS - 1]!.sim)) continue;
    let at = near.length;
    while (at > 0 && near[at - 1]!.sim < sim) at--;
    near.splice(at, 0, { ...m, sim });
    if (near.length > NEIGHBORS) near.pop();
  }
  return { score: near.reduce((sum, m) => sum + m.signal * m.sim, 0) / NEIGHBORS, near };
}

/** Scores titles from the user's marks (see Fit). */
export interface TasteModel<T extends TasteTitle = IndexEntry> {
  /** The fit score of a title, and the liked titles among those that vote on it, most similar first. Callers must not change it. */
  score(t: T): Fit<T>;
  /** Titles in the catalog that the user has not marked, with a score above this one. */
  higherThan(score: number): number;
}

/** The same text for the same marks, in any order. */
export function signalsKey(signals: ReadonlyMap<string, number>): string {
  return [...signals]
    .map(([id, n]) => `${id}=${n}`)
    .sort()
    .join(" ");
}

/** Values in the sorted list (lowest first) that are above x. */
function countAbove(sorted: Float64Array, x: number): number {
  // The first index with a value above x.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return sorted.length - lo;
}

/**
 * A model of the user's taste, or null when the marks are not a strong
 * enough signal. All of these must be true:
 * - At least MIN_MARKED marked titles are in the catalog, with at least one
 *   yes and one no. With only likes, "likes this" and "likes everything" look
 *   the same.
 * - Self-check: each thumbed title, predicted from the other marks, gets a
 *   score with the correct sign for at least MIN_SELF_CHECK of them. Few or
 *   mixed thumbs fail this. "Not interested" titles vote but are not checked:
 *   they come from the recommendations, so they are near the liked titles by
 *   design.
 *
 * The model and its scores are kept for the catalog until the marks change.
 */
export function tasteModel<T extends TasteTitle>(catalog: readonly T[], signals: ReadonlyMap<string, number>): TasteModel<T> | null {
  const p = prepare(catalog);
  const key = signalsKey(signals);
  if (p.last?.key !== key) p.last = { key, model: buildModel(catalog, signals, p) };
  return p.last.model;
}

function buildModel<T extends TasteTitle>(
  catalog: readonly T[],
  signals: ReadonlyMap<string, number>,
  p: Prepared<T>,
): TasteModel<T> | null {
  const marked = [...signals].flatMap(([id, signal]) => {
    const t = p.byId.get(id);
    return t ? [{ t, f: p.features(t), signal }] : [];
  });
  if (marked.length < MIN_MARKED || !marked.some((m) => m.signal > 0) || !marked.some((m) => m.signal < 0)) return null;

  const checked = marked.filter((m) => Math.abs(m.signal) === 1);
  const hits = checked.filter((m) => Math.sign(predict(m.t, m.f, marked).score) === Math.sign(m.signal)).length;
  if (!checked.length || hits / checked.length < MIN_SELF_CHECK) return null;

  const scores = new Map<TasteTitle, Fit<T>>();
  const score = (t: T): Fit<T> => {
    let fit = scores.get(t);
    if (!fit) {
      const r = predict(t, p.features(t), marked);
      fit = { score: r.score, likedNear: r.near.filter((m) => m.signal > 0).map((m) => m.t) };
      scores.set(t, fit);
    }
    return fit;
  };
  /** Scores of the titles the user has not marked, lowest first. Made on first use. */
  let sorted: Float64Array | null = null;
  return {
    score,
    higherThan(x) {
      sorted ??= Float64Array.from(catalog.flatMap((t) => (signals.has(t.id) ? [] : [score(t).score]))).sort();
      return countAbove(sorted, x);
    },
  };
}

/**
 * Every score of a model, as plain data for a worker to send (see
 * modelFromTable): the scores in catalog order, the ids of the liked titles
 * near each, and the scores of the unmarked titles, lowest first.
 */
export interface ScoreTable {
  ids: string[];
  scores: Float64Array;
  likedNear: string[][];
  unmarked: Float64Array;
}

/** Score every title in the catalog (see tasteModel). Null when the marks give no model. */
export function scoreTable(catalog: readonly TasteTitle[], signals: ReadonlyMap<string, number>): ScoreTable | null {
  const model = tasteModel(catalog, signals);
  if (!model) return null;
  const fits = catalog.map((t) => model.score(t));
  return {
    ids: catalog.map((t) => t.id),
    scores: Float64Array.from(fits, (f) => f.score),
    likedNear: fits.map((f) => f.likedNear.map((t) => t.id)),
    unmarked: Float64Array.from(catalog.flatMap((t, i) => (signals.has(t.id) ? [] : [fits[i]!.score]))).sort(),
  };
}

/** The model from a score table, with the titles from byId. A title not in the table scores 0. */
export function modelFromTable<T extends TasteTitle>(table: ScoreTable, byId: ReadonlyMap<string, T>): TasteModel<T> {
  const row = new Map(table.ids.map((id, i) => [id, i]));
  const fits = new Map<string, Fit<T>>();
  return {
    score(t) {
      let fit = fits.get(t.id);
      if (!fit) {
        const i = row.get(t.id);
        fit =
          i === undefined
            ? { score: 0, likedNear: [] }
            : {
                score: table.scores[i]!,
                likedNear: table.likedNear[i]!.flatMap((id) => {
                  const near = byId.get(id);
                  return near ? [near] : [];
                }),
              };
        fits.set(t.id, fit);
      }
      return fit;
    },
    higherThan: (x) => countAbove(table.unmarked, x),
  };
}

/**
 * A strong match for the title, or null. A fit shows only when the user has
 * not marked the title, the marks give a taste model (see tasteModel), and the
 * title's score is at least MIN_FIT and in the top TOP_SHARE of the scores of
 * the titles the user has not marked. model: one made already for these marks
 * (see src/client/tasteClient.ts); without it, fitFor makes it.
 */
export function fitFor(
  id: string,
  catalog: readonly IndexEntry[],
  thumbs: Thumbs,
  notInterested: Readonly<Record<string, unknown>> = {},
  model?: TasteModel | null,
): Fit | null {
  const signals = markSignals(thumbs, notInterested);
  const target = catalog.find((t) => t.id === id);
  if (!target || signals.has(id)) return null;
  const m = model === undefined ? tasteModel(catalog, signals) : model;
  if (!m) return null;

  const fit = m.score(target);
  if (fit.score < MIN_FIT) return null;
  return m.higherThan(fit.score) < TOP_SHARE * catalog.length ? fit : null;
}
