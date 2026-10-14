import { config } from "../config.js";
import { HttpError, fetchJson } from "../http.js";
import { isReleased } from "../refreshPolicy.js";
import type { SearchResult } from "../../shared/types.js";
import { truncate, type WorkDetails } from "./types.js";

const BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w92";

function tmdb<T>(pathAndQuery: string): Promise<T> {
  if (!config.tmdbApiKey) throw new HttpError(503, "TMDB_API_KEY is not configured");
  const url = new URL(`${BASE}${pathAndQuery}`);
  const headers: Record<string, string> = { accept: "application/json" };
  // v4 read access tokens are JWTs; v3 keys are short hex strings.
  if (config.tmdbApiKey.startsWith("eyJ")) headers.authorization = `Bearer ${config.tmdbApiKey}`;
  else url.searchParams.set("api_key", config.tmdbApiKey);
  return fetchJson<T>(url.toString(), { headers });
}

const yearOf = (date: string | null | undefined): number | null =>
  date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;

interface MultiSearchItem {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  popularity?: number;
}

export async function searchTmdb(query: string): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  const data = await tmdb<{ results: MultiSearchItem[] }>(
    `/search/multi?query=${q}&include_adult=false&language=en-US&page=1`,
  );
  return data.results
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .map((r): SearchResult => {
      const kind = r.media_type === "movie" ? "movie" : "tv";
      return {
        id: `tmdb-${kind}-${r.id}`,
        kind,
        title: (kind === "movie" ? r.title : r.name) ?? "Untitled",
        year: yearOf(kind === "movie" ? r.release_date : r.first_air_date),
        detail: truncate(r.overview, 140) || null,
        imageUrl: r.poster_path ? `${IMAGE_BASE}${r.poster_path}` : null,
      };
    });
}

interface Named {
  name: string;
}

interface MovieDetails {
  title: string;
  release_date?: string;
  overview?: string;
  tagline?: string;
  runtime?: number;
  genres?: Named[];
  keywords?: { keywords?: Named[] };
  release_dates?: {
    results: { iso_3166_1: string; release_dates: { certification: string }[] }[];
  };
}

export async function getMovie(tmdbId: string, now: Date): Promise<WorkDetails> {
  const m = await tmdb<MovieDetails>(`/movie/${tmdbId}?append_to_response=release_dates,keywords&language=en-US`);
  const releaseDate = m.release_date || null;
  const usCert = m.release_dates?.results
    .find((r) => r.iso_3166_1 === "US")
    ?.release_dates.map((d) => d.certification)
    .find((c) => c);
  const context = [
    `Type: movie`,
    `Title: ${m.title}`,
    `Release date: ${releaseDate ?? "unknown"}`,
    usCert ? `US certification (MPA): ${usCert}` : "",
    m.runtime ? `Runtime: ${m.runtime} minutes` : "",
    m.genres?.length ? `Genres: ${m.genres.map((g) => g.name).join(", ")}` : "",
    m.tagline ? `Tagline: ${m.tagline}` : "",
    m.overview ? `Overview: ${m.overview}` : "",
    m.keywords?.keywords?.length
      ? `Keywords: ${m.keywords.keywords.slice(0, 30).map((k) => k.name).join(", ")}`
      : "",
  ].filter(Boolean);
  return { title: m.title, subtitle: null, releaseDate, released: isReleased(releaseDate, now), context };
}

interface TvDetails {
  name: string;
  first_air_date?: string;
  overview?: string;
  genres?: Named[];
  seasons?: { season_number: number; name: string; air_date: string | null; episode_count: number }[];
  content_ratings?: { results: { iso_3166_1: string; rating: string }[] };
}

export interface TvSeries {
  title: string;
  year: number | null;
  overview: string | null;
  seasons: { seasonNumber: number; name: string; airDate: string | null; episodeCount: number }[];
}

function getTvDetails(tmdbId: string): Promise<TvDetails> {
  return tmdb<TvDetails>(`/tv/${tmdbId}?append_to_response=content_ratings&language=en-US`);
}

export async function getTvSeries(tmdbId: string): Promise<TvSeries> {
  const tv = await getTvDetails(tmdbId);
  return {
    title: tv.name,
    year: yearOf(tv.first_air_date),
    overview: tv.overview || null,
    // Season 0 holds specials; it is not rated.
    seasons: (tv.seasons ?? [])
      .filter((s) => s.season_number >= 1)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        airDate: s.air_date,
        episodeCount: s.episode_count,
      })),
  };
}

interface SeasonDetails {
  name: string;
  overview?: string;
  air_date?: string | null;
  episodes?: { episode_number: number; name: string; overview?: string; air_date: string | null }[];
}

export async function getTvSeason(tmdbId: string, seasonNumber: number, now: Date): Promise<WorkDetails> {
  const [tv, season] = await Promise.all([
    getTvDetails(tmdbId),
    tmdb<SeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}?language=en-US`),
  ]);
  const episodes = season.episodes ?? [];
  const aired = episodes.filter((e) => isReleased(e.air_date, now));

  // Season age = air date of the most recent aired episode, so a season that
  // is still airing stays in the young buckets and keeps refreshing.
  const releaseDate = aired.length
    ? aired.map((e) => e.air_date!).sort().at(-1)!
    : (episodes[0]?.air_date ?? season.air_date ?? null);

  const usRating = tv.content_ratings?.results.find((r) => r.iso_3166_1 === "US")?.rating;
  const context = [
    `Type: TV series, one season`,
    `Series: ${tv.name}`,
    `Season: ${season.name} (season ${seasonNumber})`,
    `Series first aired: ${tv.first_air_date ?? "unknown"}`,
    usRating ? `US TV rating: ${usRating}` : "",
    tv.genres?.length ? `Genres: ${tv.genres.map((g) => g.name).join(", ")}` : "",
    tv.overview ? `Series overview: ${tv.overview}` : "",
    season.overview ? `Season overview: ${season.overview}` : "",
    `Episodes aired so far: ${aired.length} of ${episodes.length}`,
    ...aired.map(
      (e) => `Episode ${e.episode_number} "${e.name}" (${e.air_date}): ${truncate(e.overview, 300) || "no synopsis"}`,
    ),
  ].filter(Boolean);

  return {
    title: tv.name,
    subtitle: season.name,
    releaseDate,
    released: aired.length > 0,
    context,
  };
}
