import path from "node:path";
import { getRecommendations, parseScreenId } from "./catalog/tmdb.js";
import { HttpError } from "./http.js";
import { TtlFileCache } from "./ttlCache.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Ids of similar titles for a movie or TV series, from TMDB recommendations,
 * best first. Kept in <CACHE_DIR>/similar/ for one week (they change slowly),
 * with older files as a fallback up to 30 days when TMDB fails. The API keeps
 * only the rated ones, when it answers, so new ratings show at once.
 */
export class SimilarService {
  private readonly cache: TtlFileCache<string[]>;

  constructor(
    cacheDir: string,
    private readonly fetch: (kind: "movie" | "tv", tmdbId: string) => Promise<string[]> = getRecommendations,
    ttlMs = 7 * DAY,
    keepMs = 30 * DAY,
  ) {
    this.cache = new TtlFileCache(path.join(cacheDir, "similar"), ttlMs, keepMs);
  }

  /** id: tmdb-movie-603, tmdb-tv-1399, or a season (tmdb-tv-1399-s01), which gets the series' list. */
  async title(id: string, now = Date.now()): Promise<string[]> {
    const screen = parseScreenId(id);
    if (!screen) throw new HttpError(400, "Similar titles are known for TMDB movies and TV series only");
    const { kind, tmdbId } = screen;
    return (await this.cache.load(`${kind}-${tmdbId}`, () => this.fetch(kind, tmdbId), now)).value;
  }

  prune(now = Date.now()): Promise<number> {
    return this.cache.prune(now);
  }
}
