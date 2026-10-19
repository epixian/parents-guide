import fs from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, type Report } from "../shared/types.js";

// One JSON file per work or TV season:
//   <CACHE_DIR>/movie/603.json
//   <CACHE_DIR>/tv/1399/s01.json
//   <CACHE_DIR>/book/OL82563W.json

export interface ReportCache {
  get(id: string): Promise<Report | null>;
  set(report: Report): Promise<void>;
  /** Every saved result with the current schema. */
  listAll(): Promise<Report[]>;
}

/** Map a validated report id to a path relative to the cache root. Returns null for invalid ids. */
export function cachePathFor(id: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^tmdb-movie-(\d{1,10})$/.exec(id))) return path.join("movie", `${m[1]}.json`);
  if ((m = /^tmdb-tv-(\d{1,10})-s(\d{2,3})$/.exec(id))) return path.join("tv", m[1]!, `s${m[2]}.json`);
  if ((m = /^ol-(OL\d{1,12}W)$/.exec(id))) return path.join("book", `${m[1]}.json`);
  return null;
}

const RESULT_DIRS = new Set(["movie", "tv", "book"]);

export class FileReportCache implements ReportCache {
  /** onWrite: called with the path inside root after each saved result (used for the off-site backup). */
  constructor(
    private readonly root: string,
    private readonly onWrite?: (rel: string) => void,
  ) {}

  private resolve(id: string): string {
    const rel = cachePathFor(id);
    if (!rel) throw new Error(`Invalid report id: ${id}`);
    return path.join(this.root, rel);
  }

  async get(id: string): Promise<Report | null> {
    try {
      const text = await fs.readFile(this.resolve(id), "utf8");
      const report = JSON.parse(text) as Report;
      // An older result shape counts as missing, so the title is rated again.
      return report.schemaVersion === SCHEMA_VERSION ? report : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof SyntaxError) {
        console.warn(`Ignoring corrupt cache file for ${id}`);
        return null;
      }
      throw err;
    }
  }

  async listAll(): Promise<Report[]> {
    // Only the result folders: CACHE_DIR also holds other files (batch-catalog/, popularity.json) and,
    // in production, the .git folder of the backup, which is slow to read.
    const files = (
      await Promise.all(
        [...RESULT_DIRS].map(async (dir) =>
          (await fs.readdir(path.join(this.root, dir), { recursive: true }).catch(() => [] as string[])).map((rel) =>
            path.join(dir, rel),
          ),
        ),
      )
    ).flat();
    const reports: Report[] = [];
    for (const rel of files) {
      if (!rel.endsWith(".json")) continue;
      try {
        const report = JSON.parse(await fs.readFile(path.join(this.root, rel), "utf8")) as Report;
        if (report.schemaVersion === SCHEMA_VERSION && cachePathFor(report.id) === rel) reports.push(report);
      } catch {
        // Corrupt or partly written file: skip it.
      }
    }
    return reports;
  }

  async set(report: Report): Promise<void> {
    const file = this.resolve(report.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temp file, then rename, so readers never see a partial file.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
    this.onWrite?.(cachePathFor(report.id)!);
  }
}
