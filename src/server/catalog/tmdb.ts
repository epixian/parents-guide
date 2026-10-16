import { config } from "../config.js";
import { HttpError, fetchJson } from "../http.js";
import { isReleased } from "../refreshPolicy.js";
import type { CreditEntry, SearchResult, WatchOffer, WorkInfo } from "../../shared/types.js";
import { audienceScore, creditLines, credits, truncate, type WorkDetails } from "./types.js";

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
        released: isReleased((kind === "movie" ? r.release_date : r.first_air_date) || null, new Date()),
        detail: truncate(r.overview, 140) || null,
        imageUrl: r.poster_path ? `${IMAGE_BASE}${r.poster_path}` : null,
      };
    });
}

interface Named {
  id?: number;
  name: string;
}

interface Credits {
  cast?: { id: number; name: string; order?: number }[];
  crew?: { id: number; name: string; job: string }[];
}

const SITE = "https://www.themoviedb.org";

/** A TMDB person, company, or network with a link to its TMDB page. */
const linked =
  (kind: "person" | "company" | "network") =>
  (n: Named): CreditEntry => ({ name: n.name, url: n.id ? `${SITE}/${kind}/${n.id}` : null });
const person = linked("person");
const company = linked("company");
const network = linked("network");

const POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const poster = (path: string | null | undefined) => (path ? `${POSTER_BASE}${path}` : null);

/** Top-billed cast. */
function topCast(c: Credits | undefined, n = 5): CreditEntry[] {
  return [...(c?.cast ?? [])]
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, n)
    .map(person);
}

/** TMDB user score (0-10). */
const tmdbScore = (d: { vote_average?: number; vote_count?: number }) =>
  audienceScore("TMDB", d.vote_average, d.vote_count, 10, 25);

interface MovieDetails {
  title: string;
  vote_average?: number;
  vote_count?: number;
  release_date?: string;
  overview?: string;
  tagline?: string;
  runtime?: number;
  poster_path?: string | null;
  genres?: Named[];
  production_companies?: Named[];
  credits?: Credits;
  keywords?: { keywords?: Named[] };
  release_dates?: {
    results: { iso_3166_1: string; release_dates: { certification: string }[] }[];
  };
}

export async function getMovie(tmdbId: string, now: Date): Promise<WorkDetails> {
  const m = await tmdb<MovieDetails>(
    `/movie/${tmdbId}?append_to_response=release_dates,keywords,credits&language=en-US`,
  );
  const releaseDate = m.release_date || null;
  const usCert = m.release_dates?.results
    .find((r) => r.iso_3166_1 === "US")
    ?.release_dates.map((d) => d.certification)
    .find((c) => c);

  const info: WorkInfo = {
    years: yearOf(releaseDate)?.toString() ?? null,
    rating: usCert ? { system: "MPA", value: usCert } : null,
    credits: credits([
      ["Director", (m.credits?.crew ?? []).filter((p) => p.job === "Director").map(person)],
      ["Starring", topCast(m.credits)],
      ["Studio", (m.production_companies ?? []).slice(0, 3).map(company)],
    ]),
    imageUrl: poster(m.poster_path),
    source: { name: "TMDB", url: `${SITE}/movie/${tmdbId}` },
    audience: tmdbScore(m),
    fetchedAt: now.toISOString(),
  };

  const context = [
    `Type: movie`,
    `Title: ${m.title}`,
    `Release date: ${releaseDate ?? "unknown"}`,
    usCert ? `US certification (MPA): ${usCert}` : "",
    m.runtime ? `Runtime: ${m.runtime} minutes` : "",
    m.genres?.length ? `Genres: ${m.genres.map((g) => g.name).join(", ")}` : "",
    ...creditLines(info),
    m.tagline ? `Tagline: ${m.tagline}` : "",
    m.overview ? `Overview: ${m.overview}` : "",
    m.keywords?.keywords?.length
      ? `Keywords: ${m.keywords.keywords.slice(0, 30).map((k) => k.name).join(", ")}`
      : "",
  ].filter(Boolean);
  return { title: m.title, subtitle: null, releaseDate, released: isReleased(releaseDate, now), context, info };
}

interface TvDetails {
  name: string;
  vote_average?: number;
  vote_count?: number;
  first_air_date?: string;
  last_air_date?: string;
  status?: string;
  overview?: string;
  poster_path?: string | null;
  genres?: Named[];
  created_by?: Named[];
  networks?: Named[];
  credits?: Credits;
  seasons?: { season_number: number; name: string; air_date: string | null; episode_count: number }[];
  content_ratings?: { results: { iso_3166_1: string; rating: string }[] };
}

export interface TvSeries {
  title: string;
  year: number | null;
  overview: string | null;
  info: WorkInfo;
  seasons: { seasonNumber: number; name: string; airDate: string | null; episodeCount: number }[];
}

function getTvDetails(tmdbId: string): Promise<TvDetails> {
  return tmdb<TvDetails>(`/tv/${tmdbId}?append_to_response=content_ratings,credits&language=en-US`);
}

function tvRating(tv: TvDetails): WorkInfo["rating"] {
  const value = tv.content_ratings?.results.find((r) => r.iso_3166_1 === "US")?.rating;
  return value ? { system: "TV", value } : null;
}

/** "2008–2013" for ended series, "2019–" for running ones, "2020" for one-year runs. */
function seriesYears(tv: TvDetails): string | null {
  const first = yearOf(tv.first_air_date);
  if (!first) return null;
  const ended = tv.status === "Ended" || tv.status === "Canceled";
  const last = yearOf(tv.last_air_date);
  if (!ended) return `${first}–`;
  return last && last !== first ? `${first}–${last}` : `${first}`;
}

export async function getTvSeries(tmdbId: string): Promise<TvSeries> {
  const tv = await getTvDetails(tmdbId);
  return {
    title: tv.name,
    year: yearOf(tv.first_air_date),
    overview: tv.overview || null,
    info: {
      years: seriesYears(tv),
      rating: tvRating(tv),
      credits: credits([
        ["Created by", (tv.created_by ?? []).map(person)],
        ["Starring", topCast(tv.credits)],
        ["Network", (tv.networks ?? []).slice(0, 3).map(network)],
      ]),
      imageUrl: poster(tv.poster_path),
      source: { name: "TMDB", url: `${SITE}/tv/${tmdbId}` },
      audience: tmdbScore(tv),
      fetchedAt: new Date().toISOString(),
    },
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
  poster_path?: string | null;
  credits?: Credits;
  episodes?: { episode_number: number; name: string; overview?: string; air_date: string | null }[];
}

export async function getTvSeason(tmdbId: string, seasonNumber: number, now: Date): Promise<WorkDetails> {
  const [tv, season] = await Promise.all([
    getTvDetails(tmdbId),
    tmdb<SeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}?append_to_response=credits&language=en-US`),
  ]);
  const episodes = season.episodes ?? [];
  const aired = episodes.filter((e) => isReleased(e.air_date, now));

  // Season age = air date of the most recent aired episode, so a season that
  // is still airing stays in the young buckets and keeps refreshing.
  const releaseDate = aired.length
    ? aired.map((e) => e.air_date!).sort().at(-1)!
    : (episodes[0]?.air_date ?? season.air_date ?? null);

  const seasonCast = topCast(season.credits);
  const info: WorkInfo = {
    years: yearOf(season.air_date ?? episodes[0]?.air_date)?.toString() ?? null,
    rating: tvRating(tv),
    credits: credits([
      ["Created by", (tv.created_by ?? []).map(person)],
      ["Starring", seasonCast.length ? seasonCast : topCast(tv.credits)],
      ["Network", (tv.networks ?? []).slice(0, 3).map(network)],
    ]),
    imageUrl: poster(season.poster_path ?? tv.poster_path),
    source: { name: "TMDB", url: `${SITE}/tv/${tmdbId}/season/${seasonNumber}` },
    // TMDB has vote counts for whole series only, so a season shows the series score.
    audience: tmdbScore(tv),
    fetchedAt: now.toISOString(),
  };

  const context = [
    `Type: TV series, one season`,
    `Series: ${tv.name}`,
    `Season: ${season.name} (season ${seasonNumber})`,
    `Series first aired: ${tv.first_air_date ?? "unknown"}`,
    info.rating ? `US TV rating: ${info.rating.value}` : "",
    tv.genres?.length ? `Genres: ${tv.genres.map((g) => g.name).join(", ")}` : "",
    ...creditLines(info),
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
    info,
  };
}

/**
 * The TMDB movie or TV series behind a report or series id: tmdb-movie-603,
 * tmdb-tv-1399, or a season (tmdb-tv-1399-s01), which gives its series. Null
 * for other ids (books).
 */
export function parseScreenId(id: string): { kind: "movie" | "tv"; tmdbId: string } | null {
  const m = /^tmdb-(?:movie-(\d+)|tv-(\d+)(?:-s\d+)?)$/.exec(id);
  if (!m) return null;
  return m[1] ? { kind: "movie", tmdbId: m[1] } : { kind: "tv", tmdbId: m[2]! };
}

// ---------- Similar titles ----------

interface RecommendationItem {
  id: number;
  media_type?: string;
  adult?: boolean;
}

/** Pages of 20. The page shows only rated titles, so it needs more than one page to choose from. */
const RECOMMENDATION_PAGES = 2;

/**
 * Ids of the titles that TMDB recommends for a movie or TV series
 * (tmdb-movie-N, tmdb-tv-N), best first. TMDB's "similar" list matches on
 * genres and keywords only and gives poor results; recommendations come from
 * what users watch together.
 */
export async function getRecommendations(kind: "movie" | "tv", tmdbId: string): Promise<string[]> {
  const pages = await Promise.all(
    Array.from({ length: RECOMMENDATION_PAGES }, (_, i) =>
      tmdb<{ results?: RecommendationItem[] }>(`/${kind}/${tmdbId}/recommendations?language=en-US&page=${i + 1}`),
    ),
  );
  const ids = pages
    .flatMap((p) => p.results ?? [])
    .flatMap((r) => {
      const type = r.media_type ?? kind;
      return !r.adult && (type === "movie" || type === "tv") ? [`tmdb-${type}-${r.id}`] : [];
    });
  return [...new Set(ids)];
}

// ---------- Where to watch ----------

/** Country for streaming availability. Same as the MPA and TV ratings. */
export const WATCH_REGION = "US";
const LOGO_BASE = "https://image.tmdb.org/t/p/w92";

interface ProviderItem {
  provider_id: number;
  provider_name: string;
  logo_path?: string | null;
  display_priority?: number;
  display_priorities?: Record<string, number>;
}

/** One TMDB service, before services of one brand are grouped (see groupProviders). */
export interface ProviderEntry {
  id: number;
  name: string;
  logoUrl: string | null;
  /** How the title streams there. Titles only; the catalog has none. */
  offer?: WatchOffer;
}

/** One country's offers. TMDB has these lists from JustWatch. */
export type RegionOffers = Partial<Record<"flatrate" | "free" | "ads" | "rent" | "buy", ProviderItem[]>>;

const toProvider = (p: ProviderItem, offer?: WatchOffer): ProviderEntry => ({
  id: p.provider_id,
  name: p.provider_name,
  logoUrl: p.logo_path ? `${LOGO_BASE}${p.logo_path}` : null,
  ...(offer ? { offer } : {}),
});

/**
 * Subscription, free, and free-with-ads services, one entry per service, in
 * TMDB's display order. Rent and buy offers are left out. TMDB's "free" counts
 * as a subscription: the site does not tell them apart. A service with both
 * offers keeps "free with ads".
 */
export function streamingProviders(offers: RegionOffers | undefined): ProviderEntry[] {
  const seen = new Map<number, { p: ProviderItem; offer: WatchOffer }>();
  const lists: [WatchOffer, ProviderItem[] | undefined][] = [
    ["ads", offers?.ads],
    ["subscription", offers?.flatrate],
    ["subscription", offers?.free],
  ];
  for (const [offer, list] of lists) {
    for (const p of list ?? []) if (!seen.has(p.provider_id)) seen.set(p.provider_id, { p, offer });
  }
  return [...seen.values()]
    .sort((a, b) => (a.p.display_priority ?? 999) - (b.p.display_priority ?? 999))
    .map(({ p, offer }) => toProvider(p, offer));
}

/** Streaming services for a movie or a whole TV series in WATCH_REGION. Empty when there are none. */
export async function getWatchProviders(kind: "movie" | "tv", tmdbId: string): Promise<ProviderEntry[]> {
  const data = await tmdb<{ results?: Record<string, RegionOffers> }>(`/${kind}/${tmdbId}/watch/providers`);
  return streamingProviders(data.results?.[WATCH_REGION]);
}

/** Every service TMDB knows in WATCH_REGION (movie and TV lists merged), most common first. */
export async function getProviderCatalog(): Promise<ProviderEntry[]> {
  const lists = await Promise.all(
    (["movie", "tv"] as const).map((kind) =>
      tmdb<{ results: ProviderItem[] }>(`/watch/providers/${kind}?watch_region=${WATCH_REGION}&language=en-US`),
    ),
  );
  const byId = new Map<number, ProviderItem>();
  for (const p of lists.flatMap((l) => l.results)) if (!byId.has(p.provider_id)) byId.set(p.provider_id, p);
  const rank = (p: ProviderItem) => p.display_priorities?.[WATCH_REGION] ?? p.display_priority ?? 999;
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.provider_name.localeCompare(b.provider_name)).map((p) => toProvider(p));
}
