import { CATEGORIES } from "../shared/categories.js";
import type { RecentItem, RecentResponse, Report, ReportResponse, SeriesResponse } from "../shared/types.js";
import { cachePathFor, type ReportCache } from "./cache.js";
import { getBook } from "./catalog/openlibrary.js";
import { getMovie, getTvSeason, getTvSeries } from "./catalog/tmdb.js";
import type { WorkDetails } from "./catalog/types.js";
import { classify } from "./classify.js";
import { HttpError } from "./http.js";
import type { Popularity } from "./popularity.js";
import type { RateLimiter } from "./rateLimit.js";
import { TitleIndex } from "./titleIndex.js";
import { isReleased, shouldRefresh } from "./refreshPolicy.js";

export function seasonReportId(tmdbId: string, seasonNumber: number): string {
  return `tmdb-tv-${tmdbId}-s${String(seasonNumber).padStart(2, "0")}`;
}

/** Kind and catalog loader for a report id. Throws a 400 HttpError for an invalid id. */
export function parseId(id: string): { kind: Report["kind"]; load: (now: Date) => Promise<WorkDetails> } {
  let m: RegExpExecArray | null;
  if ((m = /^tmdb-movie-(\d+)$/.exec(id))) {
    const tmdbId = m[1]!;
    return { kind: "movie", load: (now) => getMovie(tmdbId, now) };
  }
  if ((m = /^tmdb-tv-(\d+)-s(\d+)$/.exec(id))) {
    const [tmdbId, season] = [m[1]!, Number(m[2])];
    return { kind: "tv-season", load: (now) => getTvSeason(tmdbId, season, now) };
  }
  if ((m = /^ol-(OL\d+W)$/.exec(id))) {
    const workId = m[1]!;
    return { kind: "book", load: (now) => getBook(workId, now) };
  }
  throw new HttpError(400, "Invalid id");
}

/** False when the info box is missing or in an older format (before linked credits). */
function hasCurrentInfo(report: Report): boolean {
  const info = report.info;
  return !!info && "source" in info && info.credits.every((c) => Array.isArray(c.entries));
}

export class ReportService {
  /** One AI lookup at a time per id; concurrent requests share the result. */
  private readonly inFlight = new Map<string, Promise<ReportResponse>>();

  private readonly index = new TitleIndex();
  /** Loads the title index from the cache folder on first use. */
  private indexReady: Promise<void> | null = null;

  constructor(
    private readonly cache: ReportCache,
    private readonly limiter: RateLimiter,
    private readonly popularity: Popularity,
  ) {}

  /** Most viewed titles of the last week that have a saved result. */
  async getTrending(limit: number): Promise<RecentItem[]> {
    await this.loadIndex();
    // Ask for extra ids: some may be series with no rated season yet.
    const ids = this.popularity.trending(limit * 2).map((t) => t.id);
    return this.index.items(ids).slice(0, limit);
  }

  /** Count a page view for the trending list. TV seasons count toward their series. */
  recordView(id: string, visitorKey: string): void {
    this.popularity.record(id.replace(/^(tmdb-tv-\d+)-s\d+$/, "$1"), visitorKey);
  }

  /** Newest saved titles for each media kind. No catalog or AI calls. */
  async getRecent(limit: number): Promise<RecentResponse> {
    await this.loadIndex();
    return this.index.recent(limit);
  }

  /** Build the index from the cache folder one time. Call at startup to avoid a slow first request. */
  loadIndex(): Promise<void> {
    this.indexReady ??= this.cache.listAll().then((all) => {
      all.forEach((r) => this.index.add(r));
      console.log(`Title index: ${all.length} saved results`);
    });
    return this.indexReady;
  }

  /** Save a result and keep the home page list current. */
  private async save(report: Report): Promise<void> {
    await this.cache.set(report);
    this.index.add(report);
  }

  async getReport(id: string, clientKey: string): Promise<ReportResponse> {
    if (!cachePathFor(id)) throw new HttpError(400, "Invalid id");
    const { kind, load } = parseId(id);

    const now = new Date();
    const cached = await this.cache.get(id);
    if (cached && !shouldRefresh({ releaseDate: cached.releaseDate, refreshedAt: cached.refreshedAt, now })) {
      return { status: "ok", report: hasCurrentInfo(cached) ? cached : await this.addInfo(cached, load, now) };
    }

    const pending = this.inFlight.get(id);
    if (pending) return pending;

    const task = this.lookup(id, kind, load, cached, clientKey, now).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }

  /** Add or update catalog facts on a saved result. No AI call. */
  private async addInfo(cached: Report, load: (now: Date) => Promise<WorkDetails>, now: Date): Promise<Report> {
    try {
      const work = await load(now);
      const updated = { ...cached, info: work.info };
      await this.save(updated);
      return updated;
    } catch (err) {
      console.warn(`Could not add info to ${cached.id}: ${(err as Error).message}`);
      return cached;
    }
  }

  private async lookup(
    id: string,
    kind: Report["kind"],
    load: (now: Date) => Promise<WorkDetails>,
    cached: Report | null,
    clientKey: string,
    now: Date,
  ): Promise<ReportResponse> {
    // On any failure during a refresh, serve the older cached result instead.
    const fallback = (err: unknown): ReportResponse => {
      if (cached) {
        console.warn(`Refresh failed for ${id}, serving cached result: ${(err as Error).message}`);
        return { status: "ok", report: cached, stale: true };
      }
      throw err;
    };

    if (!this.limiter.take(clientKey)) {
      return fallback(new HttpError(429, "Too many new lookups. Try again later."));
    }

    let work: WorkDetails;
    try {
      work = await load(now);
    } catch (err) {
      return fallback(err);
    }
    if (!work.released) {
      if (cached) return { status: "ok", report: cached };
      return { status: "unreleased", title: work.title, releaseDate: work.releaseDate };
    }

    try {
      const report = await classify(id, kind, work, now);
      // A refresh keeps the date the title was first added.
      report.addedAt = cached?.addedAt ?? cached?.refreshedAt ?? report.refreshedAt;
      await this.save(report);
      console.log(`Classified ${id} (${work.title}${work.subtitle ? `, ${work.subtitle}` : ""})`);
      return { status: "ok", report };
    } catch (err) {
      return fallback(err);
    }
  }

  /** Series overview: season list with cached season results and the aggregate range. No AI calls. */
  async getSeries(tmdbId: string): Promise<SeriesResponse> {
    if (!/^\d{1,10}$/.test(tmdbId)) throw new HttpError(400, "Invalid id");
    const now = new Date();
    const series = await getTvSeries(tmdbId);

    const seasons = await Promise.all(
      series.seasons.map(async (s) => {
        const reportId = seasonReportId(tmdbId, s.seasonNumber);
        return {
          ...s,
          released: isReleased(s.airDate, now),
          reportId,
          report: await this.cache.get(reportId),
        };
      }),
    );

    const rated = seasons.filter((s) => s.report).map((s) => s.report!);
    const releasedSeasons = seasons.filter((s) => s.released).length;
    const categories: SeriesResponse["aggregate"]["categories"] = {};
    for (const c of CATEGORIES) {
      const scores = rated.map((r) => r.categories[c.id]?.score).filter((n): n is number => typeof n === "number");
      if (scores.length) categories[c.id] = { min: Math.min(...scores), max: Math.max(...scores) };
    }

    return {
      id: `tmdb-tv-${tmdbId}`,
      title: series.title,
      year: series.year,
      overview: series.overview,
      info: series.info,
      seasons,
      aggregate: {
        ratedSeasons: rated.length,
        releasedSeasons,
        partial: rated.length < releasedSeasons,
        categories,
      },
    };
  }
}
