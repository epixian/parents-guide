// Fixed theme tags for browsing and filtering. The AI picks tags from this
// list; its free-text themes are for display only, because free text is too
// varied to filter on ("friendship" vs "female friendship and loyalty").
// Adding tags is safe. Renaming or removing one orphans it in saved results.

export const THEME_TAGS = [
  "adventure",
  "ambition",
  "animals",
  "betrayal",
  "bullying",
  "coming-of-age",
  "courage",
  "crime-and-justice",
  "death-and-grief",
  "disability",
  "divorce",
  "faith",
  "family",
  "fantasy-and-magic",
  "forgiveness",
  "found-family",
  "friendship",
  "good-vs-evil",
  "greed",
  "heroism",
  "history",
  "honesty",
  "humor",
  "identity",
  "immigration",
  "loneliness",
  "love-and-romance",
  "loyalty",
  "mental-health",
  "music-and-art",
  "mystery",
  "nature",
  "overcoming-adversity",
  "parenting",
  "poverty",
  "power-and-corruption",
  "prejudice",
  "rebellion",
  "redemption",
  "revenge",
  "sacrifice",
  "school",
  "science-and-technology",
  "self-discovery",
  "siblings",
  "sports",
  "survival",
  "teamwork",
  "war",
] as const;

export type ThemeTag = (typeof THEME_TAGS)[number];

const KNOWN = new Set<string>(THEME_TAGS);

/** Keep known tags only, in order, without duplicates. Accepts loose spelling ("Coming of Age"). */
export function normalizeThemeTags(raw: string[]): ThemeTag[] {
  const out: ThemeTag[] = [];
  for (const r of raw) {
    const tag = r.trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (KNOWN.has(tag) && !out.includes(tag as ThemeTag)) out.push(tag as ThemeTag);
  }
  return out;
}
