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
 * Part of the similarity from the theme tags; the rest is from the mood.
 * Most titles for children have a similar mood, so mood alone says little.
 */
const TAG_WEIGHT = 2 / 3;
/** Mood distance (on the 1-5 scales) at which two moods have no similarity. */
const MOOD_FAR = 2;

export interface Fit {
  /**
   * -1 to 1: the sum of the signals of the NEIGHBORS most similar marked
   * titles, times their similarity, divided by NEIGHBORS. Near likes give a
   * high score; far likes give a low score.
   */
  score: number;
  /** Liked titles among the near ones, most similar first. */
  likedNear: IndexEntry[];
}

interface Marked {
  t: IndexEntry;
  signal: number;
}

/** Rarity of each tag in the catalog: a tag that most titles have says little. */
function rarity(catalog: readonly IndexEntry[]): (tag: ThemeTag) => number {
  const count = new Map<ThemeTag, number>();
  for (const t of catalog) for (const tag of new Set(t.themeTags)) count.set(tag, (count.get(tag) ?? 0) + 1);
  return (tag) => Math.log(1 + catalog.length / (count.get(tag) ?? 1));
}

/**
 * Similarity of two titles, 0 to 1: the tag similarity (cosine, with rare
 * tags weighted more) and the mood closeness, by TAG_WEIGHT. Tags only when
 * either title has no mood.
 */
function similarity(a: IndexEntry, b: IndexEntry, rare: (tag: ThemeTag) => number): number {
  const tb = new Set(b.themeTags);
  let shared = 0;
  let na = 0;
  let nb = 0;
  for (const tag of new Set(a.themeTags)) {
    const w = rare(tag) ** 2;
    na += w;
    if (tb.has(tag)) shared += w;
  }
  for (const tag of tb) nb += rare(tag) ** 2;
  const tags = na && nb ? shared / Math.sqrt(na * nb) : 0;
  if (!a.mood || !b.mood) return tags;
  const d = Math.hypot(a.mood.tone - b.mood.tone, a.mood.feeling - b.mood.feeling, a.mood.depth - b.mood.depth);
  return TAG_WEIGHT * tags + (1 - TAG_WEIGHT) * Math.max(0, 1 - d / MOOD_FAR);
}

/** The fit score (see Fit) and the marked titles that vote on it, most similar first. */
function predict(t: IndexEntry, marked: readonly Marked[], rare: (tag: ThemeTag) => number) {
  const near = marked
    .filter((m) => m.t.id !== t.id)
    .map((m) => ({ ...m, sim: similarity(t, m.t, rare) }))
    .filter((m) => m.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, NEIGHBORS);
  return { score: near.reduce((sum, m) => sum + m.signal * m.sim, 0) / NEIGHBORS, near };
}

/** Scores titles from the user's marks (see Fit). */
export interface TasteModel {
  /** The fit score of a title, and the liked titles among those that vote on it, most similar first. */
  score(t: IndexEntry): { score: number; likedNear: IndexEntry[] };
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
 */
export function tasteModel(catalog: readonly IndexEntry[], signals: ReadonlyMap<string, number>): TasteModel | null {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const marked = [...signals].flatMap(([id, signal]) => (byId.has(id) ? [{ t: byId.get(id)!, signal }] : []));
  if (marked.length < MIN_MARKED || !marked.some((m) => m.signal > 0) || !marked.some((m) => m.signal < 0)) return null;

  const rare = rarity(catalog);
  const checked = marked.filter((m) => Math.abs(m.signal) === 1);
  const hits = checked.filter((m) => Math.sign(predict(m.t, marked, rare).score) === Math.sign(m.signal)).length;
  if (!checked.length || hits / checked.length < MIN_SELF_CHECK) return null;

  return {
    score(t) {
      const p = predict(t, marked, rare);
      return { score: p.score, likedNear: p.near.filter((m) => m.signal > 0).map((m) => m.t) };
    },
  };
}

/**
 * A strong match for the title, or null. A fit shows only when the user has
 * not marked the title, the marks give a taste model (see tasteModel), and the
 * title's score is at least MIN_FIT and in the top TOP_SHARE of the scores of
 * the titles the user has not marked.
 */
export function fitFor(
  id: string,
  catalog: readonly IndexEntry[],
  thumbs: Thumbs,
  notInterested: Readonly<Record<string, unknown>> = {},
): Fit | null {
  const signals = markSignals(thumbs, notInterested);
  const target = catalog.find((t) => t.id === id);
  if (!target || signals.has(id)) return null;
  const model = tasteModel(catalog, signals);
  if (!model) return null;

  const fit = model.score(target);
  if (fit.score < MIN_FIT) return null;
  const higher = catalog.filter((t) => !signals.has(t.id) && model.score(t).score > fit.score).length;
  return higher < TOP_SHARE * catalog.length ? fit : null;
}
