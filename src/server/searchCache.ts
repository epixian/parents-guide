import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SearchResult } from "../shared/types.js";

export interface SearchResponse {
  results: SearchResult[];
  warnings: string[];
}

/**
 * Catalog search answers on disk, one file per normalized query in
 * <CACHE_DIR>/search/. Files kept across restarts and deploys; anything older
 * than the time limit is ignored and later deleted by prune().
 */
export class SearchCache {
  private readonly dir: string;

  /** ttlMs: six hours keeps new releases and "not yet released" labels current. */
  constructor(
    cacheDir: string,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
  ) {
    this.dir = path.join(cacheDir, "search");
  }

  /** "Star  Wars " and "star wars" share one entry. */
  static key(q: string): string {
    return q.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private file(q: string): string {
    const hash = createHash("sha256").update(SearchCache.key(q)).digest("hex").slice(0, 32);
    return path.join(this.dir, `${hash}.json`);
  }

  async get(q: string, now = Date.now()): Promise<SearchResponse | null> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file(q), "utf8")) as { at: number; response: SearchResponse };
      return now - saved.at < this.ttlMs ? saved.response : null;
    } catch {
      return null; // Missing or unreadable: search again.
    }
  }

  async set(q: string, response: SearchResponse, now = Date.now()): Promise<void> {
    const file = this.file(q);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ at: now, q: SearchCache.key(q), response }), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn(`Could not cache search: ${(err as Error).message}`);
    }
  }

  /** Delete expired files. Returns how many were deleted. */
  async prune(now = Date.now()): Promise<number> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    let deleted = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs >= this.ttlMs) {
        await fs.rm(file, { force: true });
        deleted++;
      }
    }
    return deleted;
  }
}
