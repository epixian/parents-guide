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
  /** The title's page at its catalog source. */
  source: { name: string; url: string } | null;
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
}

export type RecentResponse = Record<MediaKind, RecentItem[]>;

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
  themeTags: ThemeTag[];
  /** Highest score per category (across seasons for TV). */
  scores: Partial<Record<CategoryId, number>>;
  /** Every treatment seen per category (across seasons for TV). */
  treatments: Partial<Record<CategoryId, TreatmentId[]>>;
}

export interface ApiError {
  error: string;
}
