import type { BookCategory } from "./bookCategories.js";
import type { CategoryId, TreatmentId } from "./categories.js";
import type { ThemeTag } from "./themes.js";

/** Bump when the Report shape changes. Cached files with another version are re-rated. */
export const SCHEMA_VERSION = 2;

export type MediaKind = "movie" | "tv" | "book";

export interface SearchResult {
  /** Report or series id: tmdb-movie-603, tmdb-tv-1399, ol-OL82563W */
  id: string;
  kind: MediaKind;
  title: string;
  year: number | null;
  /** Short line for disambiguation (author, overview excerpt). */
  detail: string | null;
  imageUrl: string | null;
  /** False when the catalog has a future release date or none (movies and TV). Shown as a label. */
  released: boolean;
}

/** One credited person or company, with a link to its catalog page when known. */
export interface CreditEntry {
  name: string;
  url: string | null;
}

/** Catalog facts for the info box. Comes from TMDB or Open Library, not from the AI. */
export interface WorkInfo {
  /** e.g. "1999" or "2008–2013" */
  years: string | null;
  /** e.g. { system: "MPA", value: "PG-13" } or { system: "TV", value: "TV-14" } */
  rating: { system: string; value: string } | null;
  /** Labeled lists in display order, e.g. Director, Starring, Studio, Author, Publisher. */
  credits: { label: string; entries: CreditEntry[] }[];
  imageUrl: string | null;
  /** Book subtitle, e.g. "The Graphic Novel" (see bookSubtitle). Books only; null when none. Older files may not have it. */
  subtitle?: string | null;
  /** The title's page at its catalog source. */
  source: { name: string; url: string } | null;
  /** Average user score at the catalog source. Null when it has too few votes. Older files may not have it. */
  audience?: AudienceScore | null;
  /** ISO timestamp of the catalog lookup. The server reloads facts older than 30 days. Older files may not have it. */
  fetchedAt?: string;
  /** TMDB genres in movie names (see screenGenres), e.g. ["Action", "Thriller"]. Movies and TV only. Older files may not have it. */
  genres?: string[];
}

/** Average user score at a catalog source, e.g. TMDB 8.7 / 10 from 27,000 votes. */
export interface AudienceScore {
  source: string;
  average: number;
  scale: number;
  count: number;
}

/** The feel of the whole work. See src/shared/mood.ts. */
export interface Mood {
  /** 1 bleak, 2 somber, 3 even, 4 hopeful, 5 uplifting. Shown as "Outlook". */
  tone: number;
  /** 1 low-key, 2 mild, 3 moderate, 4 strong, 5 powerful: how strongly the work stirs emotions. Shown as "Pull". */
  feeling: number;
  /** 1 silly, 2 lighthearted, 3 moderate, 4 thoughtful, 5 profound: how much the work gives to think about. */
  depth: number;
  /** One sentence from the AI that explains the values. Saved, not shown. */
  note: string;
  /** Scale version (MOOD_VERSION in src/shared/mood.ts). Older moods have none and are rated again. */
  version?: number;
}

export interface CategoryRating {
  score: number;
  /** How the work presents the content. Null for categories without a treatment. */
  treatment: TreatmentId | null;
  notes: string;
}

/** One cached AI result. Stored as one JSON file per work (or per TV season). */
export interface Report {
  schemaVersion: number;
  /** tmdb-movie-603, tmdb-tv-1399-s01, ol-OL82563W */
  id: string;
  kind: "movie" | "tv-season" | "book";
  title: string;
  /** e.g. "Season 1" for TV seasons. */
  subtitle: string | null;
  /** YYYY-MM-DD. Used for the refresh policy. Null when unknown (books only). */
  releaseDate: string | null;
  /** ISO timestamp of the AI lookup that produced this result. */
  refreshedAt: string;
  /** ISO timestamp of the first AI lookup for this id. Kept across refreshes. Older files may not have it. */
  addedAt?: string;
  model: string;
  promptVersion: number;
  summary: string;
  /** How well the AI knows this work: low means details may be unreliable. */
  confidence: "high" | "medium" | "low";
  categories: Record<CategoryId, CategoryRating>;
  /** Positive elements (faith, courage, honesty, ...). Not scored. */
  positives: string[];
  /** Major themes, e.g. "grief", "coming of age". From the AI. Older files may not have it. */
  themes?: string[];
  /** Theme tags from the fixed list, for filtering. Older files may not have them. */
  themeTags?: ThemeTag[];
  /** Library categories from the fixed list (age level, type, format, genre). Books only. Older files may not have them; the backfill script adds them. */
  bookCategories?: BookCategory[];
  /** Tone, feeling, and depth. Older files may not have it; GET /api/mood/:id or the backfill script adds it. */
  mood?: Mood;
  /** Catalog facts. Older cached files may not have it; the server adds it on the next read. */
  info?: WorkInfo;
}

export type ReportResponse =
  | { status: "ok"; report: Report; stale?: boolean }
  | { status: "unreleased"; title: string; releaseDate: string | null };

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  airDate: string | null;
  episodeCount: number;
  released: boolean;
  /** Report id for this season: tmdb-tv-1399-s01 */
  reportId: string;
  /** Cached report, if this season was rated before. */
  report: Report | null;
}

export interface CategoryRange {
  min: number;
  max: number;
}

export interface SeriesResponse {
  id: string;
  title: string;
  year: number | null;
  overview: string | null;
  info: WorkInfo;
  seasons: SeasonSummary[];
  aggregate: {
    ratedSeasons: number;
    releasedSeasons: number;
    /** True until every released season has a rating. */
    partial: boolean;
    categories: Partial<Record<CategoryId, CategoryRange>>;
  };
}

/** One title in the home page "Recently added" lists. */
export interface RecentItem {
  /** Page to open: a report id, or a series id (tmdb-tv-1399) for TV. */
  id: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
  addedAt: string;
  /** Highest score per category (across seasons for TV), for the card's composite bars. */
  scores: Partial<Record<CategoryId, number>>;
}

export type RecentResponse = Record<MediaKind, RecentItem[]>;

/** One search suggestion: a rated or popular title that matches what the visitor is typing. */
export interface Suggestion {
  /** Page to open: a report id, or a series id (tmdb-tv-1399) for TV. */
  id: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
  /** Book subtitle (see WorkInfo.subtitle). Rated books only. */
  subtitle?: string;
  /**
   * False for a popular TMDB title with no saved result: opening it starts an AI lookup.
   * Null when the rated list did not load, so it is not known.
   */
  rated: boolean | null;
}

/** One popular movie or TV series from TMDB, for search suggestions. Id as in IndexEntry (tmdb-movie-603, tmdb-tv-1399). */
export interface CatalogEntry {
  id: string;
  kind: "movie" | "tv";
  title: string;
  year: number | null;
}

/**
 * GET /api/catalog: popular TMDB titles as [tmdb id, title, year] rows, without
 * key names, so the list stays small (see src/server/catalogIndex.ts).
 */
export type CatalogResponse = Record<CatalogEntry["kind"], [number, string, number | null][]>;

/**
 * GET /api/titles/changes?since=<tag>: the titles that changed after the
 * browser's copy with that tag, or reset when the browser must load the whole
 * list (GET /api/titles) again.
 */
export type TitleChanges = { tag: string; changed: IndexEntry[] } | { tag: string; reset: true };

/** One title in the browse index. TV series merge their rated seasons. */
export interface IndexEntry {
  /** Report id, or series id (tmdb-tv-1399) for TV. */
  id: string;
  kind: MediaKind;
  title: string;
  years: string | null;
  imageUrl: string | null;
  addedAt: string;
  /** 1 for movies and books; number of rated seasons for TV. */
  ratedParts: number;
  /** Book subtitle (see WorkInfo.subtitle). Left out when there is none. */
  subtitle?: string;
  themeTags: ThemeTag[];
  /** Library categories (see Report.bookCategories). Books only; left out when there are none. */
  bookCategories?: BookCategory[];
  /** Highest score per category (across seasons for TV). */
  scores: Partial<Record<CategoryId, number>>;
  /** Every treatment seen per category (across seasons for TV). */
  treatments: Partial<Record<CategoryId, TreatmentId[]>>;
  /** Mood on the current scales (the newest rated season that has one, for TV). Left out when unknown. */
  mood?: { tone: number; feeling: number; depth: number };
  /** TMDB genres (see WorkInfo.genres). Left out for books and titles not looked up yet. */
  genres?: string[];
  /** User score at the catalog source (TMDB or Open Library) as a percent, so both sort together. Left out when unknown. */
  userScore?: number;
  /** TMDB ids of the services that stream it (see WatchService.sweep). Left out for books and titles with none or not looked up yet. */
  providers?: number[];
}

export type BrowseSort = "added" | "title" | "year" | "score" | "random";

/** One page of browse results. See src/server/browse.ts for the filters. */
export interface BrowseResponse {
  /** Number of titles that match the filters. */
  total: number;
  offset: number;
  items: IndexEntry[];
  /** Theme tags across all matches, most common first. */
  tags: { tag: ThemeTag; count: number }[];
  /** Book categories across all matches, in list order. */
  bookCategories: { id: BookCategory; count: number }[];
}

/** How a title streams on a service: in a subscription (or free), or free with ads. Rent and buy are never shown. */
export type WatchOffer = "subscription" | "ads";

/**
 * One streaming brand, from TMDB (data by JustWatch). TMDB lists some brands
 * many times (Starz, Starz Amazon Channel, Starz Apple TV channel); the
 * server groups them into one entry.
 */
export interface WatchProvider {
  /** TMDB provider id of the main service in the group. */
  id: number;
  name: string;
  logoUrl: string | null;
  /** TMDB provider ids of every service in the group. These ids do not change when a name changes. */
  ids: number[];
  /** 0-9 for the top 10 US services (0 is the most used), else null. */
  rank: number | null;
  /** How the title streams there: "ads" when any service in the group has it free with ads. Titles only; "My services" has none. */
  offer?: WatchOffer;
}

/** Where a movie or TV series streams (subscription, free, or with ads; never rent or buy). */
export interface WatchResponse {
  /** Country code, e.g. "US". */
  region: string;
  providers: WatchProvider[];
  /** ISO timestamp of the TMDB lookup. */
  fetchedAt: string;
}

export interface ApiError {
  error: string;
}
