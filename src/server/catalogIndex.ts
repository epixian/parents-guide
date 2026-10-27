import fs from "node:fs/promises";
import path from "node:path";
import type { CatalogResponse } from "../shared/types.js";
import { discoverPage, type DiscoverSort } from "./catalog/tmdb.js";

// Popular TMDB movies and TV series, so search suggestions can show titles
// that nobody rated yet. The list comes from TMDB discover once a week, never
// from what visitors type, so it shows nothing about other people's searches.
// Saved in <CACHE_DIR>/catalog-titles.json, so a restart does not rebuild it.
//
// About 10,000 titles (about 125 KB with Brotli): the 5,000 movies and 5,000 TV
// series with the most TMDB votes, plus about 100 of each that are popular
// now. A build makes about 550 requests and takes about 3 minutes. Books are
// not in the list: the Open Library dumps are too large.

/** Pages to read for each kind and sort order. */
const PAGES: Record<DiscoverSort, number> = { votes: 250, popular: 25 };
/** Rebuild the list when it is older than this. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Wait after each TMDB request, as the streaming sweep does. */
const PAUSE_MS = 250;

interface Saved {
  version: 1;
  at: number;
  titles: CatalogResponse;
}

type FetchPage = typeof discoverPage;

export class CatalogIndex {
  private readonly file: string;
  private saved: Saved | null = null;
  private json: { at: number; text: string } | null = null;
  private building = false;

  constructor(
    cacheDir: string,
    private readonly fetchPage: FetchPage = discoverPage,
    private readonly pauseMs = PAUSE_MS,
  ) {
    this.file = path.join(cacheDir, "catalog-titles.json");
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Saved;
      if (saved.version === 1 && saved.titles) this.use(saved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Ignoring unreadable catalog list: ${(err as Error).message}`);
      }
    }
  }

  /** The list as JSON text, and a tag that changes with each build. Null until the first build. */
  response(): { tag: string; text: string } | null {
    if (!this.saved) return null;
    if (this.json?.at !== this.saved.at) this.json = { at: this.saved.at, text: JSON.stringify(this.saved.titles) };
    return { tag: String(this.saved.at), text: this.json.text };
  }

  /** Rebuild the list from TMDB when it is missing or older than a week. A failed build keeps the old list. */
  async refresh(now = Date.now()): Promise<void> {
    if (this.building || (this.saved && now - this.saved.at < MAX_AGE_MS)) return;
    this.building = true;
    try {
      const titles = await this.build(new Date(now).toISOString().slice(0, 10));
      const saved: Saved = { version: 1, at: now, titles };
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(saved), "utf8");
      await fs.rename(tmp, this.file);
      this.use(saved);
      console.log(`Catalog list: ${titles.movie.length} movies, ${titles.tv.length} TV series`);
    } catch (err) {
      console.warn(`Catalog list build failed: ${(err as Error).message}`);
    } finally {
      this.building = false;
    }
  }

  private async build(today: string): Promise<CatalogResponse> {
    const titles: CatalogResponse = { movie: [], tv: [] };
    for (const kind of ["movie", "tv"] as const) {
      const seen = new Set<number>();
      for (const sort of ["votes", "popular"] as const) {
        for (let page = 1; page <= PAGES[sort]; page++) {
          // One more try after a pause, so one TMDB hiccup does not lose the whole build.
          const items = await this.fetchPage(kind, sort, page, today).catch(async () => {
            await new Promise((resolve) => setTimeout(resolve, this.pauseMs * 20));
            return this.fetchPage(kind, sort, page, today);
          });
          for (const item of items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            titles[kind].push([item.id, item.title, item.year]);
          }
          if (this.pauseMs) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
          if (!items.length) break; // Past the last page.
        }
      }
    }
    return titles;
  }

  private use(saved: Saved): void {
    this.saved = saved;
  }
}
