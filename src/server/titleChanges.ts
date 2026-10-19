import fs from "node:fs/promises";

// When each title in GET /api/titles last changed, kept across restarts in
// <CACHE_DIR>/title-changes.json, so browsers ask for the changes since their
// copy (GET /api/titles/changes) and never need the whole list again.
//
// Each title keeps a hash of its index entry. TitleIndex compares the hash of
// the current entry with it: at startup for every title, then for each title
// that changes. A different hash moves the title's time to now. So results
// written by scripts while the server ran (batch, mood backfill) and a change
// to the entry fields (a new field for every title) count as changes after
// the next start.
//
// The file only saves work: if it is lost or a write is lost, titles are sent
// again, never missed.

/** Wait this long after a change before writing the file, so many changes make one write. */
const SAVE_DELAY_MS = 30_000;

interface Saved {
  version: 1;
  /** title id -> [changed at (ms), entry hash] */
  titles: Record<string, [number, string]>;
}

export class TitleChangeLog {
  private titles = new Map<string, [number, string]>();
  private saveTimer: NodeJS.Timeout | null = null;

  /** file: where to save, or null to keep the times in memory only (tests). */
  constructor(private readonly file: string | null) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Saved;
      if (saved.version === 1 && saved.titles) this.titles = new Map(Object.entries(saved.titles));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Ignoring unreadable title changes file: ${(err as Error).message}`);
      }
    }
  }

  /** When the title last changed (ms), or 0 when unknown. */
  at(id: string): number {
    return this.titles.get(id)?.[0] ?? 0;
  }

  /** Record the title's entry hash. A new or different hash sets the title's time to now; returns true then. */
  update(id: string, hash: string, now: number): boolean {
    if (this.titles.get(id)?.[1] === hash) return false;
    this.titles.set(id, [now, hash]);
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Write pending changes now, for example when the server stops. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const saved: Saved = { version: 1, titles: Object.fromEntries(this.titles) };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(saved), "utf8");
      await fs.rename(tmp, this.file);
    } catch (err) {
      console.warn(`Could not save title changes: ${(err as Error).message}`);
    }
  }
}
