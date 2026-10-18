import type { CategoryId } from "./categories.js";
import { markSignals, tagWeights, tasteModel } from "./taste.js";
import type { IndexEntry } from "./types.js";

/** Liked titles needed before high concern scores count against a title. */
export const MIN_LIKED_FOR_LIMITS = 3;
/** With the taste model, each concern point above a limit takes this from the match (fit scores run -1 to 1). */
export const MODEL_LIMIT_PENALTY = 0.1;

export interface RecommendOptions {
  /** Titles not to recommend, e.g. the watchlist. Thumbed titles are always left out. */
  exclude?: ReadonlySet<string>;
  /** Titles the user marked "Not interested" (id → anything): left out, and a weak no for their tags. */
  notInterested?: Readonly<Record<string, unknown>>;
  /** Categories the user cares about (not hidden). Only these limit scores. */
  categories: readonly CategoryId[];
  limit: number;
}

/**
 * Rated titles for the user, from their thumbs. Runs in the browser; the
 * thumbs never leave it.
 *
 * - Match, with a strong enough signal (see tasteModel): the fit score, from
 *   theme tags (rare ones weighted more) and mood.
 * - Match, without one: each tag gets the sum of the signals of the marked
 *   titles with it (see markSignals): +1 liked, -1 disliked, less for "Not
 *   interested". A title's match is the sum over its tags.
 * - Concern limits: with at least MIN_LIKED_FOR_LIMITS liked titles, the
 *   highest score of each shown category among them is the user's limit. Each
 *   point above a limit takes 1 from the tag match, or MODEL_LIMIT_PENALTY
 *   from the fit score.
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
  const notInterested = opts.notInterested ?? {};
  const signals = markSignals(thumbs, notInterested);
  const model = tasteModel(catalog, signals);
  const weight = model ? null : tagWeights(signals, (id) => byId.get(id)?.themeTags);

  const limits = new Map<CategoryId, number>();
  if (liked.length >= MIN_LIKED_FOR_LIMITS) {
    for (const id of opts.categories) {
      const known = liked.map((t) => t.scores[id]).filter((n): n is number => typeof n === "number");
      if (known.length) limits.set(id, Math.max(...known));
    }
  }

  const match = (t: IndexEntry) => {
    let over = 0;
    for (const [id, limit] of limits) over += Math.max(0, (t.scores[id] ?? 0) - limit);
    if (model) return model.score(t).score - MODEL_LIMIT_PENALTY * over;
    let sum = 0;
    for (const tag of new Set(t.themeTags)) sum += weight!.get(tag) ?? 0;
    return sum - over;
  };

  return catalog
    .filter((t) => !(t.id in thumbs) && !(t.id in notInterested) && !opts.exclude?.has(t.id))
    .map((t, i) => ({ t, i, match: match(t) }))
    .filter((r) => r.match > 0)
    .sort((a, b) => b.match - a.match || a.i - b.i)
    .slice(0, opts.limit)
    .map((r) => r.t);
}
