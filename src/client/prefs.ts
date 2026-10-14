import { CATEGORIES, type CategoryId } from "../shared/categories.js";

// Categories the user marked as non-concern. Stored in localStorage so the
// choice persists across visits. The server never sees it.
const KEY = "pairents.hiddenCategories";

export function loadHidden(): Set<CategoryId> {
  try {
    const raw = localStorage.getItem(KEY);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    const known = new Set<string>(CATEGORIES.map((c) => c.id));
    return new Set(ids.filter((id): id is CategoryId => known.has(id)));
  } catch {
    return new Set();
  }
}

export function saveHidden(hidden: Set<CategoryId>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

export function visibleCategories(hidden: Set<CategoryId>) {
  return CATEGORIES.filter((c) => !hidden.has(c.id));
}
