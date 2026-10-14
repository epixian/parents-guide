import fs from "node:fs/promises";
import path from "node:path";
import type { Report } from "../shared/types.js";

// One JSON file per work or TV season:
//   <CACHE_DIR>/movie/603.json
//   <CACHE_DIR>/tv/1399/s01.json
//   <CACHE_DIR>/book/OL82563W.json

export interface ReportCache {
  get(id: string): Promise<Report | null>;
  set(report: Report): Promise<void>;
}

/** Map a validated report id to a path relative to the cache root. Returns null for invalid ids. */
export function cachePathFor(id: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^tmdb-movie-(\d{1,10})$/.exec(id))) return path.join("movie", `${m[1]}.json`);
  if ((m = /^tmdb-tv-(\d{1,10})-s(\d{2,3})$/.exec(id))) return path.join("tv", m[1]!, `s${m[2]}.json`);
  if ((m = /^ol-(OL\d{1,12}W)$/.exec(id))) return path.join("book", `${m[1]}.json`);
  return null;
}

export class FileReportCache implements ReportCache {
  constructor(private readonly root: string) {}

  private resolve(id: string): string {
    const rel = cachePathFor(id);
    if (!rel) throw new Error(`Invalid report id: ${id}`);
    return path.join(this.root, rel);
  }

  async get(id: string): Promise<Report | null> {
    try {
      const text = await fs.readFile(this.resolve(id), "utf8");
      return JSON.parse(text) as Report;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof SyntaxError) {
        console.warn(`Ignoring corrupt cache file for ${id}`);
        return null;
      }
      throw err;
    }
  }

  async set(report: Report): Promise<void> {
    const file = this.resolve(report.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temp file, then rename, so readers never see a partial file.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }
}
