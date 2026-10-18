import type { ThemeTag } from "./themes.js";
import { tagWeights } from "./taste.js";

/**
 * Order similar titles by the user's marks (see markSignals). Each theme tag
 * gets a weight: the sum of the signals of the marked titles that have it. A
 * similar title scores the sum of the weights of its tags. Higher scores come
 * first; equal scores keep the given (TMDB) order, so with no marks the order
 * does not change. Marked titles and similar titles not in the catalog add
 * nothing.
 */
export function rankSimilar<T extends { id: string }>(
  items: readonly T[],
  signals: ReadonlyMap<string, number>,
  tagsOf: (id: string) => readonly ThemeTag[] | undefined,
): T[] {
  const weight = tagWeights(signals, tagsOf);
  if (!weight.size) return [...items];
  const score = (id: string) => [...new Set(tagsOf(id) ?? [])].reduce((sum, tag) => sum + (weight.get(tag) ?? 0), 0);
  return items
    .map((item, i) => ({ item, i, score: score(item.id) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
}
