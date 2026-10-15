import { CATEGORIES, type CategoryId, type TreatmentId } from "../shared/categories.js";
import type { ThemeTag } from "../shared/themes.js";
import type { IndexEntry, MediaKind, RecentItem, RecentResponse, Report } from "../shared/types.js";

const KIND: Record<Report["kind"], MediaKind> = { movie: "movie", "tv-season": "tv", book: "book" };

/** Compact form of one saved result (one movie, book, or TV season). */
interface ResultEntry {
  titleId: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
  /** When the title was first rated. Older files have no addedAt. */
  addedAt: string;
  themeTags: ThemeTag[];
  scores: Partial<Record<CategoryId, number>>;
  treatments: Partial<Record<CategoryId, TreatmentId>>;
}

function toEntry(r: Report): ResultEntry {
  const kind = KIND[r.kind];
  const scores: ResultEntry["scores"] = {};
  const treatments: ResultEntry["treatments"] = {};
  for (const c of CATEGORIES) {
    const rating = r.categories[c.id];
    if (!rating) continue;
    scores[c.id] = rating.score;
    if (rating.treatment) treatments[c.id] = rating.treatment;
  }
  return {
    titleId: kind === "tv" ? r.id.replace(/-s\d+$/, "") : r.id,
    kind,
    title: r.title,
    years: r.info?.years ?? null,
    imageUrl: r.info?.imageUrl ?? null,
    addedAt: r.addedAt ?? r.refreshedAt,
    themeTags: r.themeTags ?? [],
    scores,
    treatments,
  };
}

/** Merge TV seasons into one series entry: highest score per category, all treatments and tags. */
function mergeTitle(results: ResultEntry[]): IndexEntry {
  const newest = results.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
  const scores: IndexEntry["scores"] = {};
  const treatments: IndexEntry["treatments"] = {};
  const tagCounts = new Map<ThemeTag, number>();
  for (const r of results) {
    for (const [id, score] of Object.entries(r.scores) as [CategoryId, number][]) {
      scores[id] = Math.max(scores[id] ?? 0, score);
    }
    for (const [id, t] of Object.entries(r.treatments) as [CategoryId, TreatmentId][]) {
      const list = (treatments[id] ??= []);
      if (!list.includes(t)) list.push(t);
    }
    for (const tag of r.themeTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  return {
    id: newest.titleId,
    kind: newest.kind,
    title: newest.title,
    years: newest.years,
    imageUrl: newest.imageUrl,
    addedAt: newest.addedAt,
    ratedParts: results.length,
    themeTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag),
    scores,
    treatments,
  };
}

function toItem(t: IndexEntry): RecentItem {
  return { id: t.id, kind: t.kind, title: t.title, years: t.years, imageUrl: t.imageUrl, addedAt: t.addedAt };
}

/**
 * In-memory index of every saved result, for the home page and (later)
 * browsing and filtering. Built from the cache folder once at startup, then
 * updated on every save. The cache files stay the source of truth.
 *
 * Filtering a few thousand entries in memory takes well under a millisecond.
 * If the library grows past roughly 10,000 titles, back this class with
 * SQLite instead; callers do not need to change.
 */
export class TitleIndex {
  private readonly results = new Map<string, ResultEntry>();

  add(report: Report): void {
    this.results.set(report.id, toEntry(report));
  }

  /** One entry per title; TV seasons merged by series. */
  titles(): IndexEntry[] {
    const groups = new Map<string, ResultEntry[]>();
    for (const r of this.results.values()) {
      const list = groups.get(r.titleId);
      if (list) list.push(r);
      else groups.set(r.titleId, [r]);
    }
    return [...groups.values()].map(mergeTitle);
  }

  /** Card data for the given title ids, in the same order. Unknown ids are skipped. */
  items(ids: string[]): RecentItem[] {
    const byId = new Map(this.titles().map((t) => [t.id, t]));
    return ids.flatMap((id) => {
      const t = byId.get(id);
      return t ? [toItem(t)] : [];
    });
  }

  recent(limit: number): RecentResponse {
    const out: RecentResponse = { movie: [], tv: [], book: [] };
    const sorted = this.titles().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    for (const t of sorted) {
      if (out[t.kind].length >= limit) continue;
      out[t.kind].push(toItem(t));
    }
    return out;
  }
}
