import type { ThemeTag } from "./themes.js";

/**
 * Order similar titles by the user's thumbs up. Each theme tag gets a weight:
 * the number of liked titles that have it. A similar title scores the sum of
 * the weights of its tags. Higher scores come first; equal scores keep the
 * given (TMDB) order, so with no liked titles the order does not change.
 * Liked titles and similar titles not in the catalog add nothing.
 */
export function rankSimilar<T extends { id: string }>(
  items: readonly T[],
  liked: Iterable<string>,
  tagsOf: (id: string) => readonly ThemeTag[] | undefined,
): T[] {
  const weight = new Map<ThemeTag, number>();
  for (const id of liked) {
    for (const tag of new Set(tagsOf(id) ?? [])) weight.set(tag, (weight.get(tag) ?? 0) + 1);
  }
  if (!weight.size) return [...items];
  const score = (id: string) => [...new Set(tagsOf(id) ?? [])].reduce((sum, tag) => sum + (weight.get(tag) ?? 0), 0);
  return items
    .map((item, i) => ({ item, i, score: score(item.id) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
}
