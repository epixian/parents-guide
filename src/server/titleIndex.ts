import { createHash } from "node:crypto";
import type { BookCategory } from "../shared/bookCategories.js";
import { CATEGORIES, type CategoryId, type TreatmentId } from "../shared/categories.js";
import { hasMood } from "../shared/mood.js";
import type { ThemeTag } from "../shared/themes.js";
import type { IndexEntry, MediaKind, RecentItem, RecentResponse, Report } from "../shared/types.js";
import { TitleChangeLog } from "./titleChanges.js";

const KIND: Record<Report["kind"], MediaKind> = { movie: "movie", "tv-season": "tv", book: "book" };

/** Compact form of one saved result (one movie, book, or TV season). */
interface ResultEntry {
  titleId: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
  subtitle: string | null;
  /** When the title was first rated. Older files have no addedAt. */
  addedAt: string;
  themeTags: ThemeTag[];
  bookCategories: BookCategory[];
  scores: Partial<Record<CategoryId, number>>;
  treatments: Partial<Record<CategoryId, TreatmentId>>;
  /** Catalog user score as a percent, or null. */
  userScore: number | null;
  mood: IndexEntry["mood"] | null;
  genres: string[];
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
    subtitle: r.info?.subtitle ?? null,
    addedAt: r.addedAt ?? r.refreshedAt,
    themeTags: r.themeTags ?? [],
    bookCategories: r.bookCategories ?? [],
    scores,
    treatments,
    mood: hasMood(r) ? { tone: r.mood.tone, feeling: r.mood.feeling, depth: r.mood.depth } : null,
    genres: r.info?.genres ?? [],
    userScore: r.info?.audience ? Math.round((r.info.audience.average / r.info.audience.scale) * 100) : null,
  };
}

/** Merge TV seasons into one series entry: highest score per category, all treatments, tags, and genres. */
function mergeTitle(results: ResultEntry[]): IndexEntry {
  const newest = results.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
  // TV seasons carry the series' score; use the newest one that has a score.
  const newestWith = (has: (r: ResultEntry) => boolean) =>
    results.filter(has).reduce<ResultEntry | null>((a, b) => (!a || b.addedAt > a.addedAt ? b : a), null);
  const userScore = newestWith((r) => r.userScore !== null)?.userScore;
  const mood = newestWith((r) => r.mood !== null)?.mood;
  const scores: IndexEntry["scores"] = {};
  const treatments: IndexEntry["treatments"] = {};
  const tagCounts = new Map<ThemeTag, number>();
  const genres = new Set<string>();
  for (const r of results) {
    for (const [id, score] of Object.entries(r.scores) as [CategoryId, number][]) {
      scores[id] = Math.max(scores[id] ?? 0, score);
    }
    for (const [id, t] of Object.entries(r.treatments) as [CategoryId, TreatmentId][]) {
      const list = (treatments[id] ??= []);
      if (!list.includes(t)) list.push(t);
    }
    for (const tag of r.themeTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    for (const g of r.genres) genres.add(g);
  }
  return {
    id: newest.titleId,
    kind: newest.kind,
    title: newest.title,
    years: newest.years,
    imageUrl: newest.imageUrl,
    addedAt: newest.addedAt,
    ratedParts: results.length,
    ...(newest.subtitle ? { subtitle: newest.subtitle } : {}),
    themeTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag),
    scores,
    treatments,
    // Books have one result, so no merge is needed.
    ...(newest.bookCategories.length ? { bookCategories: newest.bookCategories } : {}),
    ...(userScore != null ? { userScore } : {}),
    ...(mood ? { mood } : {}),
    ...(genres.size ? { genres: [...genres] } : {}),
  };
}

function toItem(t: IndexEntry): RecentItem {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    years: t.years,
    imageUrl: t.imageUrl,
    addedAt: t.addedAt,
    scores: t.scores,
  };
}

/**
 * In-memory index of every saved result, for the home page, browsing, and
 * search suggestions. Built from the cache folder once at startup, then
 * updated on every save. The cache files stay the source of truth.
 *
 * Filtering a few thousand entries in memory takes well under a millisecond.
 * If the library grows past roughly 10,000 titles, back this class with
 * SQLite instead; callers do not need to change.
 */
export class TitleIndex {
  /**
   * log: when each title last changed (see TitleChangeLog). clock: the time
   * for a change (tests).
   */
  constructor(
    private readonly log = new TitleChangeLog(null),
    private readonly clock: () => number = Date.now,
  ) {}

  private readonly results = new Map<string, ResultEntry>();
  /** Streaming service ids per title id. Kept apart from results: they come from TMDB, not the saved files. */
  private readonly streaming = new Map<string, number[]>();
  /** Goes up on every add, so clients can tell when their copy is out of date. */
  private changes = 0;
  /** Title ids (series ids for TV) with a change that the log has not checked yet. */
  private readonly dirty = new Set<string>();
  /** False until startTracking(): at startup the entries are not complete yet. */
  private tracking = false;
  /** The newest change time of any title: the tag for GET /api/titles/changes. */
  private newest = 0;
  private merged: { changes: number; titles: IndexEntry[] } | null = null;

  /** Add or replace a result. A save that changes nothing in the index (a refresh with the same scores) keeps the version. */
  add(report: Report): void {
    const entry = toEntry(report);
    const old = this.results.get(report.id);
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    this.results.set(report.id, entry);
    this.dirty.add(entry.titleId);
    this.changes++;
  }

  /** Set the streaming service ids of a movie or TV series. A list that is the same as before keeps the version. */
  setProviders(titleId: string, ids: number[]): void {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    if ((this.streaming.get(titleId) ?? []).join() === sorted.join()) return;
    if (sorted.length) this.streaming.set(titleId, sorted);
    else this.streaming.delete(titleId);
    this.dirty.add(titleId);
    this.changes++;
  }

  /** Ids of every movie and TV series, for the streaming sweep. */
  screenIds(): string[] {
    return this.titles().flatMap((t) => (t.kind === "book" ? [] : [t.id]));
  }

  /** Changes since startup. Part of the ETag for GET /api/titles. */
  get version(): number {
    return this.changes;
  }

  /**
   * Start to record changes in the log. Call when the entries are complete
   * (results and streaming services loaded), so a half-built entry at startup
   * does not count as a change. The first check covers every title.
   */
  startTracking(): void {
    this.tracking = true;
    this.titles();
  }

  /** The newest change time (ms) of any title. Titles that change later get a larger time. */
  get newestChange(): number {
    this.titles();
    return this.newest;
  }

  /** Titles that changed after the time. Titles are never removed, so these are all the changes. */
  changedSince(time: number): IndexEntry[] {
    return this.titles().filter((t) => this.log.at(t.id) > time);
  }

  /** One entry per title; TV seasons merged by series. Callers must not change the array. */
  titles(): readonly IndexEntry[] {
    if (this.merged?.changes !== this.changes) this.merged = { changes: this.changes, titles: this.merge() };
    if (this.tracking && this.dirty.size) this.check(this.merged.titles);
    return this.merged.titles;
  }

  /** Compare each changed title's entry with its hash in the log. */
  private check(titles: readonly IndexEntry[]): void {
    // Always after the newest change, so a client with that tag never misses a change in the same millisecond.
    const now = Math.max(this.clock(), this.newest + 1);
    for (const t of titles) {
      if (!this.dirty.has(t.id)) continue;
      this.log.update(t.id, createHash("sha1").update(JSON.stringify(t)).digest("base64url"), now);
    }
    this.dirty.clear();
    this.newest = titles.reduce((max, t) => Math.max(max, this.log.at(t.id)), 0);
  }

  private merge(): IndexEntry[] {
    const groups = new Map<string, ResultEntry[]>();
    for (const r of this.results.values()) {
      const list = groups.get(r.titleId);
      if (list) list.push(r);
      else groups.set(r.titleId, [r]);
    }
    return [...groups.values()].map((results) => {
      const t = mergeTitle(results);
      const providers = this.streaming.get(t.id);
      return providers ? { ...t, providers } : t;
    });
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
    const sorted = [...this.titles()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    for (const t of sorted) {
      if (out[t.kind].length >= limit) continue;
      out[t.kind].push(toItem(t));
    }
    return out;
  }
}
