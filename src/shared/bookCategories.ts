// Library-style categories for books, for browsing and filtering. The AI picks
// them from this fixed list, like the theme tags. Movies and TV have TMDB
// genres instead (see WorkInfo.genres).
//
// A book has one age level, one type, any formats that apply, and one to
// three genres (fiction) or subjects (nonfiction). Theme tags already cover
// adventure, humor, and mystery as themes; these say what shelf a library
// puts the book on.
//
// Adding categories is safe. Renaming or removing one orphans it in saved results.

export const BOOK_CATEGORY_GROUPS = [
  { id: "level", label: "Age level", max: 1 },
  { id: "type", label: "Type", max: 1 },
  { id: "format", label: "Format", max: 3 },
  { id: "fiction", label: "Fiction genre", max: 3 },
  { id: "nonfiction", label: "Nonfiction subject", max: 3 },
] as const;

export type BookCategoryGroup = (typeof BOOK_CATEGORY_GROUPS)[number]["id"];

export const BOOK_CATEGORIES = [
  { id: "picture-book", label: "Picture book", group: "level", description: "Mostly pictures, read aloud to young children (ages 2-6)." },
  { id: "early-reader", label: "Early reader", group: "level", description: "Short, simple text for children learning to read (ages 5-8)." },
  { id: "chapter-book", label: "Chapter book", group: "level", description: "Short illustrated chapters for new independent readers (ages 6-9)." },
  { id: "middle-grade", label: "Middle grade", group: "level", description: "Written for ages 8-12." },
  { id: "young-adult", label: "Young adult", group: "level", description: "Written for teens, ages 12-18." },
  { id: "adult", label: "Adult", group: "level", description: "Written for adults, including classics read in school." },
  { id: "fiction", label: "Fiction", group: "type", description: "Invented stories." },
  { id: "nonfiction", label: "Nonfiction", group: "type", description: "True events, real people, and facts." },
  { id: "graphic-novel", label: "Graphic novel", group: "format", description: "Told in comic panels, including manga and comics collections." },
  { id: "verse", label: "Poetry and verse", group: "format", description: "A poetry collection, or a novel told in verse." },
  { id: "short-stories", label: "Short stories", group: "format", description: "A collection of separate stories." },
  { id: "fantasy", label: "Fantasy", group: "fiction", description: "Magic, mythical creatures, or invented worlds." },
  { id: "science-fiction", label: "Science fiction", group: "fiction", description: "Future technology, space, or science beyond today." },
  { id: "dystopian", label: "Dystopian", group: "fiction", description: "A future society that went wrong." },
  { id: "mystery-thriller", label: "Mystery and thriller", group: "fiction", description: "A crime or puzzle to solve, or suspense and danger." },
  { id: "horror", label: "Horror", group: "fiction", description: "Written to frighten." },
  { id: "romance", label: "Romance", group: "fiction", description: "A love story is the main plot." },
  { id: "historical-fiction", label: "Historical fiction", group: "fiction", description: "Invented story set in a real past time." },
  { id: "realistic-fiction", label: "Realistic fiction", group: "fiction", description: "Invented story that could happen today, without magic." },
  { id: "classic", label: "Classic", group: "fiction", description: "An older work widely read and taught for generations." },
  { id: "biography-memoir", label: "Biography and memoir", group: "nonfiction", description: "The life of a real person." },
  { id: "history", label: "History", group: "nonfiction", description: "Real past events." },
  { id: "science-nature", label: "Science and nature", group: "nonfiction", description: "Science, animals, the body, or the natural world." },
  { id: "faith-religion", label: "Faith and religion", group: "nonfiction", description: "Religious teaching, devotion, or the Bible." },
  { id: "self-help", label: "Self-help", group: "nonfiction", description: "Advice for life, habits, or relationships." },
  { id: "true-crime", label: "True crime", group: "nonfiction", description: "Real crimes and their investigation." },
] as const satisfies readonly { id: string; label: string; group: BookCategoryGroup; description: string }[];

export type BookCategory = (typeof BOOK_CATEGORIES)[number]["id"];

export const BOOK_CATEGORY_BY_ID = new Map<string, (typeof BOOK_CATEGORIES)[number]>(BOOK_CATEGORIES.map((c) => [c.id, c]));

/** For the AI prompts: the rules and the list, one line per category. */
export const BOOK_CATEGORY_RULES = `book_categories: for a book, the library categories from this fixed list, spelled exactly as shown. Pick exactly one age level and exactly one type; any formats that apply; and one to three fiction genres (for fiction) or nonfiction subjects (for nonfiction). For movies and TV, always an empty list.
${BOOK_CATEGORY_GROUPS.map(
  (g) => `${g.label}${g.max === 1 ? " (exactly one)" : ""}:\n${BOOK_CATEGORIES.filter((c) => c.group === g.id)
    .map((c) => `- ${c.id}: ${c.description}`)
    .join("\n")}`,
).join("\n")}`;

/**
 * Keep known categories only, in list order, at most the group's max per
 * group (the first ones the AI gave win). Accepts loose spelling ("Young Adult").
 */
export function normalizeBookCategories(raw: string[]): BookCategory[] {
  const picked = new Set<string>();
  const perGroup = new Map<BookCategoryGroup, number>();
  for (const r of raw) {
    const c = BOOK_CATEGORY_BY_ID.get(r.trim().toLowerCase().replace(/&/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-"));
    if (!c || picked.has(c.id)) continue;
    const n = perGroup.get(c.group) ?? 0;
    if (n >= BOOK_CATEGORY_GROUPS.find((g) => g.id === c.group)!.max) continue;
    perGroup.set(c.group, n + 1);
    picked.add(c.id);
  }
  return BOOK_CATEGORIES.filter((c) => picked.has(c.id)).map((c) => c.id);
}
