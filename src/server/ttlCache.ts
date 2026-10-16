import fs from "node:fs/promises";
import path from "node:path";

export interface Saved<T> {
  /** Time of the fetch, in ms. */
  at: number;
  value: T;
}

/**
 * Catalog answers on disk, one JSON file per key in one folder. A file younger
 * than ttlMs is used as is. An older one is fetched again on the next request
 * and replaced. If the fetch fails, an older file (up to keepMs) is used
 * instead of an error. prune() deletes files older than keepMs.
 */
export class TtlFileCache<T> {
  /** Lookups in progress, so many requests for one key make one fetch. */
  private readonly pending = new Map<string, Promise<Saved<T>>>();

  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly keepMs: number,
  ) {}

  load(key: string, fetch: () => Promise<T>, now = Date.now()): Promise<Saved<T>> {
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

  private async read(key: string): Promise<Saved<T> | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), "utf8")) as Saved<T>;
    } catch {
      return null; // Missing or unreadable: fetch again.
    }
  }

  private async write(key: string, saved: Saved<T>): Promise<void> {
    const file = this.file(key);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(saved), "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn(`Could not cache ${file}: ${(err as Error).message}`);
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
