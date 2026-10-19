import { CATEGORIES } from "../shared/categories.js";
import { hasMood } from "../shared/mood.js";
import type {
  BrowseResponse,
  CatalogEntry,
  IndexEntry,
  Mood,
  RecentItem,
  RecentResponse,
  Report,
  ReportResponse,
  SeriesResponse,
  TitleChanges,
  Suggestion,
  WorkInfo,
} from "../shared/types.js";
import { browseTitles, suggestTitles, type BrowseFilters } from "../shared/browse.js";
import { cachePathFor, type ReportCache } from "./cache.js";
import { getBook } from "./catalog/openlibrary.js";
import { getMovie, getTvSeason, getTvSeries } from "./catalog/tmdb.js";
import type { WorkDetails } from "./catalog/types.js";
import { classify, rateMood } from "./classify.js";
import { HttpError } from "./http.js";
import type { Popularity } from "./popularity.js";
import type { RateLimiter } from "./rateLimit.js";
import { TitleChangeLog } from "./titleChanges.js";
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

/** Catalog facts (credits, poster, audience score) older than this are reloaded on the next view. No AI call. */
const INFO_MAX_AGE_MS = 30 * 86_400_000;

/** False when the info box is missing, in an older format, or older than INFO_MAX_AGE_MS. */
function hasCurrentInfo(report: Report, now: Date): boolean {
  const info = report.info;
  if (!info?.fetchedAt || !info.credits.every((c) => Array.isArray(c.entries))) return false;
  return now.getTime() - Date.parse(info.fetchedAt) < INFO_MAX_AGE_MS;
}

/** New catalog facts, but keep a book's publisher: it came from the AI, which knows first editions better. */
export function mergeInfo(kind: Report["kind"], old: WorkInfo | undefined, fresh: WorkInfo): WorkInfo {
  const publisher = kind === "book" ? old?.credits.find((c) => c.label === "Publisher") : undefined;
  if (!publisher) return fresh;
  return { ...fresh, credits: [...fresh.credits.filter((c) => c.label !== "Publisher"), publisher] };
}

export class ReportService {
  /** One AI lookup at a time per id; concurrent requests share the result. */
  private readonly inFlight = new Map<string, Promise<ReportResponse>>();
  private readonly moodInFlight = new Map<string, Promise<Mood>>();

  private readonly index: TitleIndex;
  /** Loads the title index from the cache folder on first use. */
  private indexReady: Promise<void> | null = null;
  /** Start time, so an ETag from before a restart never matches. */
  private readonly started = Date.now().toString(36);

  /**
   * changeLog: when each title last changed, kept across restarts.
   * storedProviders: gives the saved streaming services of the titles to
   * setProviders before the change log checks the entries at startup, so
   * services that are not loaded yet do not count as a change.
   */
  constructor(
    private readonly cache: ReportCache,
    private readonly limiter: RateLimiter,
    private readonly popularity: Popularity,
    private readonly changeLog = new TitleChangeLog(null),
    private readonly storedProviders?: (ids: string[], save: (id: string, providers: number[]) => void) => Promise<void>,
  ) {
    this.index = new TitleIndex(changeLog);
  }

  /** Most viewed titles of the last week that have a saved result. */
  async getTrending(limit: number): Promise<RecentItem[]> {
    await this.loadIndex();
    // Ask for extra ids: some may be series with no rated season yet.
    const ids = this.popularity.trending(limit * 2).map((t) => t.id);
    return this.index.items(ids).slice(0, limit);
  }

  /** Card data for the rated titles among the ids, in the same order. Others are skipped. */
  async items(ids: string[]): Promise<RecentItem[]> {
    await this.loadIndex();
    return this.index.items(ids);
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

  /** Saved titles that match the browse filters. No catalog or AI calls. */
  async browse(filters: BrowseFilters): Promise<BrowseResponse> {
    await this.loadIndex();
    return browseTitles(this.index.titles(), filters);
  }

  /** Saved titles, then popular titles from the catalog list, for the search box as the visitor types. No catalog or AI calls. */
  async suggest(q: string, limit: number, catalog: readonly CatalogEntry[] = []): Promise<Suggestion[]> {
    await this.loadIndex();
    return suggestTitles(this.index.titles(), q, limit, catalog);
  }

  /** Every saved title, for browsing and suggestions in the browser. The tag changes when the list changes. */
  async titles(): Promise<{ tag: string; changeTag: string; titles: readonly IndexEntry[] }> {
    await this.loadIndex();
    const titles = this.index.titles();
    return { tag: `${this.started}-${this.index.version}`, changeTag: String(this.index.newestChange), titles };
  }

  /**
   * The titles that changed since a client's copy, by the tag of that copy.
   * reset: the tag is not valid or newer than the list (a lost change log), or
   * most titles changed (new entry fields), so the whole list, which is
   * compressed once per version, is smaller.
   */
  async titleChanges(since: string): Promise<TitleChanges> {
    await this.loadIndex();
    const newest = this.index.newestChange;
    const tag = String(newest);
    const time = /^\d{1,15}$/.test(since) ? Number(since) : NaN;
    if (!(time <= newest)) return { tag, reset: true };
    const changed = this.index.changedSince(time);
    if (changed.length > this.index.titles().length / 2) return { tag, reset: true };
    return { tag, changed };
  }

  /** Ids of every saved movie and TV series. */
  async screenIds(): Promise<string[]> {
    await this.loadIndex();
    return this.index.screenIds();
  }

  /** Keep the streaming services of a title (or a TV season's series) for the browse filter. */
  setProviders(id: string, providers: number[]): void {
    this.index.setProviders(id.replace(/^(tmdb-tv-\d+)-s\d+$/, "$1"), providers);
  }

  /** Build the index from the cache folder one time. Call at startup to avoid a slow first request. */
  loadIndex(): Promise<void> {
    this.indexReady ??= (async () => {
      const [all] = await Promise.all([this.cache.listAll(), this.changeLog.load()]);
      all.forEach((r) => this.index.add(r));
      await this.storedProviders?.(this.index.screenIds(), (id, providers) => this.setProviders(id, providers));
      this.index.startTracking();
      console.log(`Title index: ${all.length} saved results`);
    })();
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
      return { status: "ok", report: hasCurrentInfo(cached, now) ? cached : await this.addInfo(cached, load, now) };
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
      const updated = { ...cached, info: mergeInfo(cached.kind, cached.info, work.info) };
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

  /**
   * Mood of a saved result. A result saved before moods existed gets one from
   * the light mood prompt (about $0.001), saved for next time. One call per
   * title at a time; no rate limit, since each title needs it only once.
   */
  async getMood(id: string): Promise<Mood> {
    if (!cachePathFor(id)) throw new HttpError(400, "Invalid id");
    const cached = await this.cache.get(id);
    if (!cached) throw new HttpError(404, "This title has no saved rating");
    if (hasMood(cached)) return cached.mood;

    let task = this.moodInFlight.get(id);
    if (!task) {
      task = rateMood(cached)
        .then(async (mood) => {
          // Read the file again: a refresh may have replaced it during the AI call.
          const latest = (await this.cache.get(id)) ?? cached;
          if (hasMood(latest)) return latest.mood;
          await this.save({ ...latest, mood });
          console.log(`Added mood to ${id} (${latest.title})`);
          return mood;
        })
        .finally(() => this.moodInFlight.delete(id));
      this.moodInFlight.set(id, task);
    }
    return task;
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
