import path from "node:path";
import type { WatchOffer, WatchProvider, WatchResponse } from "../shared/types.js";
import { WATCH_REGION, getProviderCatalog, getWatchProviders, parseScreenId, type ProviderEntry } from "./catalog/tmdb.js";
import { HttpError } from "./http.js";
import { TtlFileCache } from "./ttlCache.js";

const DAY = 24 * 60 * 60 * 1000;

export interface WatchFetchers {
  title: (kind: "movie" | "tv", tmdbId: string) => Promise<ProviderEntry[]>;
  catalog: () => Promise<ProviderEntry[]>;
}

// Ways TMDB lists one brand more than once: through another store, or as a plan.
const CHANNEL = /\s+(?:amazon channel|apple tv channel|roku premium channel)$/i;
const PLAN = /\s+(?:standard with ads|free with ads|with ads|premium plus|premium|essential|kids|free)$/i;
/** Plans that are a separate product, not a plan of the brand. */
const OWN_BRAND = /^youtube premium$/i;

/** Letters and digits only: "Discovery +", "Discovery+", and "Discovery Plus" match, as do "Curiosity Stream" and "CuriosityStream". */
const plain = (name: string) => name.replace(/\+/g, "plus").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Services that TMDB lists under another name of the same brand (by plain name). */
const SAME_BRAND: Record<string, string> = {
  amazonvideo: "Amazon Prime Video",
  slingtvorange: "Sling TV",
  slingtvorangeandblue: "Sling TV",
};

/** Name of the brand: "Starz Amazon Channel" and "Starz" give "Starz"; "Paramount+ Amazon Channel" gives "Paramount+". */
export function brandName(name: string): string {
  const n = name.trim().replace(CHANNEL, "");
  const brand = OWN_BRAND.test(n) ? n : n.replace(PLAN, "");
  return SAME_BRAND[plain(brand)] ?? brand;
}

/** "Paramount+" and "Paramount Plus" give the same key. */
export const brandKey = (name: string) => plain(brandName(name));

/**
 * The top 10 US services, most used first, by brand key. They come first on
 * title pages, and "My services" lists them above the few hundred others
 * (niche services, free channels, stores).
 */
const TOP = [
  "netflix", "amazonprimevideo", "disneyplus", "hulu", "hbomax",
  "paramountplus", "peacock", "appletv", "youtubetv", "tubitv",
];

/** Logos from this site where TMDB's logo is hard to see at icon size. */
const LOGOS: Record<number, string> = {
  2528: "/logos/youtube-tv.svg", // YouTube TV: TMDB has a wide word mark.
};

/**
 * One entry per brand: the top 10 first, in TOP order, then the others in the
 * order of each brand's first service. The entry
 * uses the brand's main service (the one named only with the brand) for its
 * id, name, and logo: from the list, else from bases (the catalog), else the
 * first service of the brand in the list.
 */
export function groupProviders(list: ProviderEntry[], bases = new Map<string, ProviderEntry>()): WatchProvider[] {
  const groups = new Map<string, ProviderEntry[]>();
  for (const p of list) {
    const key = brandKey(p.name);
    const members = groups.get(key);
    if (members) members.push(p);
    else groups.set(key, [p]);
  }
  const rank = (key: string) => (TOP.includes(key) ? TOP.indexOf(key) : null);
  const byRank = (a: [string, unknown], b: [string, unknown]) => (rank(a[0]) ?? TOP.length) - (rank(b[0]) ?? TOP.length);
  return [...groups].sort(byRank).map(([key, members]) => {
    const main = members.find((m) => plain(m.name) === key) ?? bases.get(key);
    const first = members[0]!;
    const offers = members.flatMap((m) => (m.offer ? [m.offer] : []));
    const offer = OFFER_ORDER.find((o) => offers.includes(o));
    return {
      id: (main ?? first).id,
      name: (main?.name ?? brandName(first.name)).trim(),
      logoUrl: LOGOS[(main ?? first).id] ?? (main ?? first).logoUrl,
      ids: [...new Set(members.map((m) => m.id))],
      rank: rank(key),
      ...(offer ? { offer } : {}),
    };
  });
}

/** Every TMDB service id in the groups, for the browse filter. */
export const serviceIds = (providers: WatchProvider[]) => [...new Set(providers.flatMap((p) => p.ids))];

/** Free with ads first: the user can watch with no subscription. */
const OFFER_ORDER: WatchOffer[] = ["ads", "subscription"];

/** Main service of each brand in the catalog, by brand key. */
function mainServices(catalog: ProviderEntry[]): Map<string, ProviderEntry> {
  const bases = new Map<string, ProviderEntry>();
  for (const p of catalog) {
    const key = brandKey(p.name);
    if (plain(p.name) === key && !bases.has(key)) bases.set(key, p);
  }
  return bases;
}

/**
 * Streaming services per title, and the list of all services, from TMDB.
 * Kept in <CACHE_DIR>/watch/ for ttlMs, with older files as a fallback up to
 * keepMs when TMDB fails (see TtlFileCache).
 */
export class WatchService {
  private readonly cache: TtlFileCache<ProviderEntry[]>;

  constructor(
    cacheDir: string,
    private readonly fetchers: WatchFetchers = { title: getWatchProviders, catalog: getProviderCatalog },
    private readonly ttlMs = DAY,
    keepMs = 7 * DAY,
  ) {
    this.cache = new TtlFileCache(path.join(cacheDir, "watch"), ttlMs, keepMs);
  }

  /**
   * Services for a movie or TV series. id: tmdb-movie-603, tmdb-tv-1399, or a
   * season (tmdb-tv-1399-s01), which gets the series' services.
   */
  async title(id: string, now = Date.now()): Promise<WatchResponse> {
    const key = this.key(id);
    const { kind, tmdbId } = parseScreenId(id)!;
    const [saved, catalog] = await Promise.all([
      this.cache.load(key, () => this.fetchers.title(kind, tmdbId), now),
      // The catalog only gives a brand its main logo; without it the title still shows.
      this.cache.load("catalog", () => this.fetchers.catalog(), now).catch(() => null),
    ]);
    const providers = groupProviders(saved.value, mainServices(catalog?.value ?? []));
    return { region: WATCH_REGION, providers, fetchedAt: new Date(saved.at).toISOString() };
  }

  /** Every brand in WATCH_REGION, for the "My services" choices. */
  async catalog(now = Date.now()): Promise<WatchProvider[]> {
    return groupProviders((await this.cache.load("catalog", () => this.fetchers.catalog(), now)).value);
  }

  /**
   * Look up the services of each title and give them to save. A title with a
   * fresh file reads it from disk; others ask TMDB, with a pause after each
   * request so the sweep stays far below TMDB's rate limit. After maxFetches
   * requests (failed ones count too), the rest read their file at any age.
   * A failed title is skipped until the next sweep.
   */
  async sweep(
    ids: string[],
    save: (id: string, providers: number[]) => void,
    { maxFetches = Infinity, pauseMs = 250 } = {},
  ): Promise<{ fetched: number; failed: number; stale: number }> {
    let fetched = 0;
    let failed = 0;
    let stale = 0;
    for (const id of ids) {
      const now = Date.now();
      if (fetched + failed >= maxFetches) {
        // Request limit reached: use the file at any age, and fetch it on a later sweep.
        const saved = await this.cache.peek(this.key(id));
        if (!saved || now - saved.at >= this.ttlMs) stale++;
        if (saved) save(id, serviceIds(groupProviders(saved.value)));
        continue;
      }
      try {
        const res = await this.title(id, now);
        save(id, serviceIds(res.providers));
        if (Date.parse(res.fetchedAt) < now) continue;
        fetched++;
      } catch {
        failed++;
      }
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return { fetched, failed, stale };
  }

  /** Cache key of a movie or TV series (a season uses its series' key). */
  private key(id: string): string {
    const screen = parseScreenId(id);
    if (!screen) throw new HttpError(400, "Streaming services are known for TMDB movies and TV series only");
    return `${screen.kind}-${screen.tmdbId}`;
  }

  prune(now = Date.now()): Promise<number> {
    return this.cache.prune(now);
  }
}
