import type { CategoryId } from "./categories.js";

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

export interface CategoryRating {
  score: number;
  notes: string;
}

/** One cached AI result. Stored as one JSON file per work (or per TV season). */
export interface Report {
  schemaVersion: 1;
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
  model: string;
  promptVersion: number;
  summary: string;
  /** How well the AI knows this work: low means details may be unreliable. */
  confidence: "high" | "medium" | "low";
  categories: Record<CategoryId, CategoryRating>;
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
  seasons: SeasonSummary[];
  aggregate: {
    ratedSeasons: number;
    releasedSeasons: number;
    /** True until every released season has a rating. */
    partial: boolean;
    categories: Partial<Record<CategoryId, CategoryRange>>;
  };
}

export interface ApiError {
  error: string;
}
