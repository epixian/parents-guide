// Add TMDB genres to saved movie and TV season results that do not have them.
//
// Usage:
//   npm run backfill:genres -- [--dry-run] [--limit N]
//
// It reads every saved result in CACHE_DIR, gets the genres of each movie and
// TV series without them from TMDB (one call per movie or series, no AI), and
// writes only info.genres into each file. Other fields, including
// refreshedAt and info.fetchedAt, stay as they are. The server also reloads
// the catalog facts of a result without genres when a visitor opens the
// title, so this script is optional: it fills the rest.
//
// The title list is built from the files at startup: restart the server
// after this script, so the browser gets the genres.

import { getGenres, parseScreenId } from "./catalog/tmdb.js";
import { FileReportCache } from "./cache.js";
import { config } from "./config.js";

const cache = new FileReportCache(config.cacheDir);

/** TMDB requests at the same time. TMDB allows about 50 per second. */
const CONCURRENCY = 8;

function intArg(args: string[], name: string): number | null {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const n = Number(args[at + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number above 0`);
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = await cache.listAll();
  const missing = all.filter((r) => r.kind !== "book" && r.info && !r.info.genres).sort((a, b) => a.id.localeCompare(b.id));

  // TV seasons share their series' genres: one TMDB call per series.
  const bySource = new Map<string, string[]>();
  for (const r of missing) {
    const screen = parseScreenId(r.id);
    if (!screen) continue;
    const key = `${screen.kind}-${screen.tmdbId}`;
    const ids = bySource.get(key);
    if (ids) ids.push(r.id);
    else bySource.set(key, [r.id]);
  }
  const limit = intArg(args, "--limit");
  const todo = [...bySource].slice(0, limit ?? undefined);
  console.log(
    `${all.length} saved results in ${config.cacheDir}; ${missing.length} without genres, ` +
      `from ${bySource.size} movies and series.`,
  );
  if (!todo.length) {
    console.log("Nothing to do.");
    return;
  }
  if (args.includes("--dry-run")) {
    console.log(`Dry run: no TMDB calls. ${todo.length} to look up. First titles:`);
    for (const [key, ids] of todo.slice(0, 5)) console.log(`  ${key}: ${ids.join(", ")}`);
    return;
  }

  let saved = 0;
  let skipped = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [key, ids] = todo[next++]!;
      const screen = parseScreenId(ids[0]!)!;
      let genres: string[];
      try {
        genres = await getGenres(screen.kind, screen.tmdbId);
      } catch (err) {
        failed += ids.length;
        console.warn(`failed ${key}: ${(err as Error).message}`);
        continue;
      }
      for (const id of ids) {
        // Read the file again now: the server may have changed it meanwhile.
        const latest = await cache.get(id);
        if (!latest?.info || latest.info.genres) {
          skipped++;
          continue;
        }
        await cache.set({ ...latest, info: { ...latest.info, genres } });
        saved++;
        console.log(`saved ${id} (${latest.title}${latest.subtitle ? `, ${latest.subtitle}` : ""}): ${genres.join(", ") || "no genres"}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nDone: ${saved} saved, ${skipped} skipped (genres added meanwhile), ${failed} failed.`);
  if (saved) console.log("Restart the server, so the title list includes the genres.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
