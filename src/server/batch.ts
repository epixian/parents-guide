// Rate many titles at batch prices (50% off) and save them to the cache.
//
// Usage:
//   npm run batch -- <ids-file> [--dry-run]
//   npm run batch -- --resume <batch-id>
//
// The ids file has one report id per line: tmdb-movie-603, tmdb-tv-1399-s01,
// ol-OL27482W. Blank lines and lines starting with # are ignored. Titles that
// already have a saved result, and titles not yet released, are skipped.
//
// The script waits for the batch to finish (most finish within an hour, all
// within 24 hours). If it stops, run it again with --resume and the batch id
// it printed. Restart the server afterwards so the home page lists include the
// new titles.

import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { FileReportCache, cachePathFor } from "./cache.js";
import type { WorkDetails } from "./catalog/types.js";
import { buildRequest, getClient, reportFromMessage } from "./classify.js";
import { config } from "./config.js";
import { parseId } from "./reports.js";
import { estimateCost, recordUsage } from "./usage.js";

const POLL_MS = 60_000;
/** Catalog requests at a time, to stay well under TMDB and Open Library limits. */
const CATALOG_CONCURRENCY = 4;

const cache = new FileReportCache(config.cacheDir);

async function readIds(file: string): Promise<string[]> {
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/).map((l) => l.trim());
  const ids = [...new Set(lines.filter((l) => l && !l.startsWith("#")))];
  const invalid = ids.filter((id) => !cachePathFor(id));
  if (invalid.length) throw new Error(`Invalid ids: ${invalid.join(", ")}`);
  return ids;
}

/** Run fn over items with a fixed number in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Catalog metadata for each id that needs a rating. */
async function loadWork(ids: string[], now: Date): Promise<Map<string, WorkDetails>> {
  const work = new Map<string, WorkDetails>();
  await mapLimit(ids, CATALOG_CONCURRENCY, async (id) => {
    try {
      if (await cache.get(id)) {
        console.log(`skip ${id}: already saved`);
        return;
      }
      const details = await parseId(id).load(now);
      if (!details.released) {
        console.log(`skip ${id}: not yet released (${details.title})`);
        return;
      }
      work.set(id, details);
    } catch (err) {
      console.warn(`skip ${id}: ${(err as Error).message}`);
    }
  });
  return work;
}

async function waitForBatch(client: Anthropic, batchId: string): Promise<void> {
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    const c = batch.request_counts;
    console.log(
      `${new Date().toLocaleTimeString()} ${batch.processing_status}: ` +
        `${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored, ${c.expired} expired`,
    );
    if (batch.processing_status === "ended") return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Save every successful result. Loads metadata again for ids not in `work` (after --resume). */
async function saveResults(client: Anthropic, batchId: string, work: Map<string, WorkDetails>): Promise<void> {
  const now = new Date();
  let saved = 0;
  let failed = 0;
  let cost = 0;
  for await (const item of await client.messages.batches.results(batchId)) {
    const id = item.custom_id;
    if (item.result.type !== "succeeded") {
      failed++;
      const detail = item.result.type === "errored" ? `: ${item.result.error.error.message}` : "";
      console.warn(`failed ${id}: ${item.result.type}${detail}`);
      continue;
    }
    const message = item.result.message;
    const entry = { id, mode: "batch" as const, model: message.model, usage: message.usage };
    await recordUsage(entry);
    cost += estimateCost(entry) ?? 0;
    try {
      const { kind, load } = parseId(id);
      const details = work.get(id) ?? (await load(now));
      const report = reportFromMessage(id, kind, details, now, message);
      report.addedAt = report.refreshedAt;
      await cache.set(report);
      saved++;
      console.log(`saved ${id} (${details.title}${details.subtitle ? `, ${details.subtitle}` : ""})`);
    } catch (err) {
      failed++;
      console.warn(`failed ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone: ${saved} saved, ${failed} failed, cost≈$${cost.toFixed(4)}.`);
  console.log("Restart the server so the home page lists include the new titles.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const client = getClient();

  const resumeAt = args.indexOf("--resume");
  if (resumeAt >= 0) {
    const batchId = args[resumeAt + 1];
    if (!batchId) throw new Error("--resume needs a batch id");
    await waitForBatch(client, batchId);
    await saveResults(client, batchId, new Map());
    return;
  }

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Usage: npm run batch -- <ids-file> [--dry-run]  |  npm run batch -- --resume <batch-id>");

  const ids = await readIds(file);
  console.log(`${ids.length} ids in ${file}. Cache: ${config.cacheDir}`);
  const work = await loadWork(ids, new Date());
  if (!work.size) {
    console.log("Nothing to rate.");
    return;
  }

  const requests = [...work.entries()].map(([id, details]) => ({ custom_id: id, params: buildRequest(details) }));
  // Rough estimate from earlier live lookups: ~3,500 input and ~1,500 output tokens each.
  const estimate = (requests.length * (3500 * 1 + 1500 * 5)) / 1_000_000 / 2;
  console.log(`${requests.length} titles to rate. Estimated cost ≈ $${estimate.toFixed(2)} at batch prices.`);
  if (args.includes("--dry-run")) {
    console.log("Dry run: no batch sent.");
    return;
  }

  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch ${batch.id} sent. If this script stops, run: npm run batch -- --resume ${batch.id}`);
  await waitForBatch(client, batch.id);
  await saveResults(client, batch.id, work);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
