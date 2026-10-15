import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Title popularity for the home page "Trending" row.
//
// Counts title page views: one per visitor per title per UTC day. Daily
// counts are saved to <CACHE_DIR>/popularity.json; visitor identity never is.
// The duplicate check keeps salted hashes in memory for the current day only.

/** Days of history to keep on disk. */
const KEEP_DAYS = 30;
/** Days that count toward the trending score. */
export const TRENDING_DAYS = 7;
/** Weight per day of age: today 1, yesterday 0.75, then 0.56, ... */
const DECAY = 0.75;
/** A title needs this many distinct daily visitors in the window to trend. */
export const MIN_VISITORS = 2;
/** Wait this long after a view before writing the file, so many views make one write. */
const SAVE_DELAY_MS = 30_000;

/** UTC day key, e.g. "2026-10-14". */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

interface Saved {
  version: 1;
  /** day -> title id -> distinct visitors that day */
  days: Record<string, Record<string, number>>;
}

export class Popularity {
  private days: Saved["days"] = {};
  /** Salted hashes of "title|visitor" seen today. Never written to disk. */
  private seenToday = new Set<string>();
  private seenDay = "";
  private readonly salt = randomBytes(16);
  private saveTimer: NodeJS.Timeout | null = null;

  /** file: where to save the counts, or null to keep them in memory only (tests). */
  constructor(private readonly file: string | null) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as Saved;
      if (saved.version === 1 && saved.days && typeof saved.days === "object") this.days = saved.days;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Ignoring unreadable popularity file: ${(err as Error).message}`);
      }
    }
  }

  /** Count one view. Repeat views by the same visitor on the same day do not count. */
  record(titleId: string, visitorKey: string, now = new Date()): void {
    const day = dayKey(now);
    if (day !== this.seenDay) {
      this.seenToday = new Set();
      this.seenDay = day;
      this.prune(day);
    }
    const key = createHash("sha256").update(this.salt).update(`${titleId}|${visitorKey}`).digest("base64url");
    if (this.seenToday.has(key)) return;
    this.seenToday.add(key);

    const counts = (this.days[day] ??= {});
    counts[titleId] = (counts[titleId] ?? 0) + 1;
    this.scheduleSave();
  }

  /** Title ids by trending score, highest first. Only titles with enough visitors. */
  trending(limit: number, now = new Date()): { id: string; score: number; visitors: number }[] {
    const today = dayKey(now);
    const totals = new Map<string, { score: number; visitors: number }>();
    for (const [day, counts] of Object.entries(this.days)) {
      const age = daysBetween(today, day);
      if (age < 0 || age >= TRENDING_DAYS) continue;
      const weight = DECAY ** age;
      for (const [id, n] of Object.entries(counts)) {
        const t = totals.get(id) ?? { score: 0, visitors: 0 };
        t.score += n * weight;
        t.visitors += n;
        totals.set(id, t);
      }
    }
    return [...totals.entries()]
      .filter(([, t]) => t.visitors >= MIN_VISITORS)
      .sort((a, b) => b[1].score - a[1].score || b[1].visitors - a[1].visitors)
      .slice(0, limit)
      .map(([id, t]) => ({ id, ...t }));
  }

  /** Write pending counts now (for shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private prune(today: string): void {
    for (const day of Object.keys(this.days)) {
      if (daysBetween(today, day) >= KEEP_DAYS) delete this.days[day];
    }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    try {
      const saved: Saved = { version: 1, days: this.days };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(saved)}\n`, "utf8");
      await fs.rename(tmp, this.file);
    } catch (err) {
      console.warn(`Could not save popularity: ${(err as Error).message}`);
    }
  }
}
