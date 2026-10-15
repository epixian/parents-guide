import { CATEGORIES } from "../shared/categories.js";
import type { Report, ReportResponse, SeriesResponse } from "../shared/types.js";
import { cachePathFor, type ReportCache } from "./cache.js";
import { getBook } from "./catalog/openlibrary.js";
import { getMovie, getTvSeason, getTvSeries } from "./catalog/tmdb.js";
import type { WorkDetails } from "./catalog/types.js";
import { classify } from "./classify.js";
import { HttpError } from "./http.js";
import type { RateLimiter } from "./rateLimit.js";
import { isReleased, shouldRefresh } from "./refreshPolicy.js";

export function seasonReportId(tmdbId: string, seasonNumber: number): string {
  return `tmdb-tv-${tmdbId}-s${String(seasonNumber).padStart(2, "0")}`;
}

function parseId(id: string): { kind: Report["kind"]; load: (now: Date) => Promise<WorkDetails> } {
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

  constructor(
    private readonly cache: ReportCache,
    private readonly limiter: RateLimiter,
  ) {}

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
      await this.cache.set(updated);
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
      await this.cache.set(report);
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
