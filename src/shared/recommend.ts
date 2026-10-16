import type { CategoryId } from "./categories.js";
import type { IndexEntry } from "./types.js";

/** Liked titles needed before high concern scores count against a title. */
export const MIN_LIKED_FOR_LIMITS = 3;

export interface RecommendOptions {
  /** Titles not to recommend, e.g. the watchlist. Thumbed titles are always left out. */
  exclude?: ReadonlySet<string>;
  /** Categories the user cares about (not hidden). Only these limit scores. */
  categories: readonly CategoryId[];
  limit: number;
}

/**
 * Rated titles for the user, from their thumbs. Runs in the browser; the
 * thumbs never leave it.
 *
 * - Theme tags: each tag gets +1 for each liked title with it and -1 for each
 *   disliked title with it. A title's match is the sum over its tags.
 * - Concern limits: with at least MIN_LIKED_FOR_LIMITS liked titles, the
 *   highest score of each shown category among them is the user's limit. Each
 *   point above a limit takes 1 from the match.
 *
 * Titles with a match above 0 come out best first; equal matches keep the
 * catalog order. Empty when the user liked nothing.
 */
export function recommend(
  catalog: readonly IndexEntry[],
  thumbs: Readonly<Record<string, "up" | "down">>,
  opts: RecommendOptions,
): IndexEntry[] {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const liked = Object.keys(thumbs).flatMap((id) => (thumbs[id] === "up" && byId.has(id) ? [byId.get(id)!] : []));
  if (!liked.length) return [];
  const disliked = Object.keys(thumbs).flatMap((id) => (thumbs[id] === "down" && byId.has(id) ? [byId.get(id)!] : []));

  const weight = new Map<string, number>();
  const add = (t: IndexEntry, n: number) => {
    for (const tag of new Set(t.themeTags)) weight.set(tag, (weight.get(tag) ?? 0) + n);
  };
  liked.forEach((t) => add(t, 1));
  disliked.forEach((t) => add(t, -1));

  const limits = new Map<CategoryId, number>();
  if (liked.length >= MIN_LIKED_FOR_LIMITS) {
    for (const id of opts.categories) {
      const known = liked.map((t) => t.scores[id]).filter((n): n is number => typeof n === "number");
      if (known.length) limits.set(id, Math.max(...known));
    }
  }

  const match = (t: IndexEntry) => {
    let sum = 0;
    for (const tag of new Set(t.themeTags)) sum += weight.get(tag) ?? 0;
    for (const [id, limit] of limits) sum -= Math.max(0, (t.scores[id] ?? 0) - limit);
    return sum;
  };

  return catalog
    .filter((t) => !(t.id in thumbs) && !opts.exclude?.has(t.id))
    .map((t, i) => ({ t, i, match: match(t) }))
    .filter((r) => r.match > 0)
    .sort((a, b) => b.match - a.match || a.i - b.i)
    .slice(0, opts.limit)
    .map((r) => r.t);
}
