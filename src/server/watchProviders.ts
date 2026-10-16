import fs from "node:fs/promises";
import path from "node:path";
import type { WatchOffer, WatchProvider, WatchResponse } from "../shared/types.js";
import { WATCH_REGION, getProviderCatalog, getWatchProviders, type ProviderEntry } from "./catalog/tmdb.js";
import { HttpError } from "./http.js";

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

interface Saved<T> {
  at: number;
  value: T;
}

/**
 * Streaming services per title, and the list of all services, from TMDB.
 * One file per key in <CACHE_DIR>/watch/. A file younger than ttlMs is used
 * as is. An older one is fetched again on the next request and replaced. If
 * TMDB fails, an older file (up to keepMs) is used instead of an error.
 */
export class WatchService {
  private readonly dir: string;
  /** Lookups in progress, so many requests for one title make one TMDB call. */
  private readonly pending = new Map<string, Promise<Saved<ProviderEntry[]>>>();

  constructor(
    cacheDir: string,
    private readonly fetchers: WatchFetchers = { title: getWatchProviders, catalog: getProviderCatalog },
    private readonly ttlMs = DAY,
    private readonly keepMs = 7 * DAY,
  ) {
    this.dir = path.join(cacheDir, "watch");
  }

  /**
   * Services for a movie or TV series. id: tmdb-movie-603, tmdb-tv-1399, or a
   * season (tmdb-tv-1399-s01), which gets the series' services.
   */
  async title(id: string, now = Date.now()): Promise<WatchResponse> {
    const m = /^tmdb-(?:movie-(\d+)|tv-(\d+)(?:-s\d+)?)$/.exec(id);
    if (!m) throw new HttpError(400, "Streaming services are known for TMDB movies and TV series only");
    const [kind, tmdbId] = m[1] ? (["movie", m[1]] as const) : (["tv", m[2]!] as const);
    const [saved, catalog] = await Promise.all([
      this.load(`${kind}-${tmdbId}`, () => this.fetchers.title(kind, tmdbId), now),
      // The catalog only gives a brand its main logo; without it the title still shows.
      this.load("catalog", () => this.fetchers.catalog(), now).catch(() => null),
    ]);
    const providers = groupProviders(saved.value, mainServices(catalog?.value ?? []));
    return { region: WATCH_REGION, providers, fetchedAt: new Date(saved.at).toISOString() };
  }

  /** Every brand in WATCH_REGION, for the "My services" choices. */
  async catalog(now = Date.now()): Promise<WatchProvider[]> {
    return groupProviders((await this.load("catalog", () => this.fetchers.catalog(), now)).value);
  }

  private load(key: string, fetch: () => Promise<ProviderEntry[]>, now: number): Promise<Saved<ProviderEntry[]>> {
    const running = this.pending.get(key);
    if (running) return running;
    const job = this.read(key).then(async (saved) => {
      if (saved && now - saved.at < this.ttlMs) return saved;
      try {
        const fresh = { at: now, value: await fetch() };
        await this.write(key, fresh);
        return fresh;
      } catch (err) {
        if (saved && now - saved.at < this.keepMs) return saved;
        throw err;
      }
    });
    this.pending.set(key, job);
    return job.finally(() => this.pending.delete(key));
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private async read(key: string): Promise<Saved<ProviderEntry[]> | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), "utf8")) as Saved<ProviderEntry[]>;
    } catch {
      return null; // Missing or unreadable: fetch again.
    }
  }

  private async write(key: string, saved: Saved<ProviderEntry[]>): Promise<void> {
    const file = this.file(key);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(saved), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn(`Could not cache streaming services: ${(err as Error).message}`);
    }
  }

  /** Delete files older than keepMs. Returns how many were deleted. */
  async prune(now = Date.now()): Promise<number> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    let deleted = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs >= this.keepMs) {
        await fs.rm(file, { force: true });
        deleted++;
      }
    }
    return deleted;
  }
}
