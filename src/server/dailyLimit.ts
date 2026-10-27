import fs from "node:fs/promises";

// A limit on new AI lookups per day for the whole site, so the AI cost has a
// maximum whatever the callers do (a bot that looks like a browser, many IPs).
// It counts lookups, not visitors: it keeps no address or other ID. Days are
// UTC. The count starts from today's live lines in usage.jsonl, so a restart
// does not reset it.

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class DailyLimit {
  private day = "";
  private count = 0;

  /** limit: new lookups per day; 0 turns the limit off. */
  constructor(private readonly limit: number) {}

  /** Record one lookup. Returns false when today's limit is reached. */
  take(now = new Date()): boolean {
    if (!this.limit) return true;
    this.roll(now);
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  /** Start from the live AI calls of today in usage.jsonl (see usage.ts). A missing file counts as none. */
  async load(usageFile: string, now = new Date()): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(usageFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    this.roll(now);
    const today = this.day;
    for (const line of text.split("\n")) {
      // Cheap test first: the file has thousands of batch lines.
      if (!line.startsWith(`{"at":"${today}`)) continue;
      try {
        if ((JSON.parse(line) as { mode?: string }).mode === "live") this.count++;
      } catch {
        // A cut-off last line.
      }
    }
  }

  /** Lookups counted today. */
  used(now = new Date()): number {
    this.roll(now);
    return this.count;
  }

  private roll(now: Date): void {
    const day = utcDay(now);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
  }
}
