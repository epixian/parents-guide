// Add library categories (age level, type, format, genre) to saved books that do not have them, at batch prices (50% off).
//
// Usage:
//   npm run backfill:book-categories -- [--dry-run] [--limit N]
//   npm run backfill:book-categories -- --resume <batch-id>
//
// It reads every saved book in CACHE_DIR, sends the light categories prompt
// for each one without categories (see buildBookCategoriesRequest in
// classify.ts), waits for the batch, and writes only the categories into each
// file. Other fields, including refreshedAt, stay as they are. New books get
// their categories from the main prompt, so this script is for older books.
//
// Restart the server after this script, so the title list includes the categories.

import type Anthropic from "@anthropic-ai/sdk";
import type { Report } from "../shared/types.js";
import { waitForBatch } from "./batchApi.js";
import { FileReportCache } from "./cache.js";
import { bookCategoriesFromMessage, buildBookCategoriesRequest, getClient } from "./classify.js";
import { config } from "./config.js";
import { estimateCost, recordUsage } from "./usage.js";

const cache = new FileReportCache(config.cacheDir);

const needsCategories = (r: Report) => r.kind === "book" && !r.bookCategories?.length;

/** Write the categories of each successful result into its file, unless the file has them by now. */
async function saveResults(client: Anthropic, batchId: string): Promise<void> {
  let saved = 0;
  let skipped = 0;
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
      const bookCategories = bookCategoriesFromMessage(message);
      if (!bookCategories.length) throw new Error("no known categories in the answer");
      // Read the file again now: the server may have changed it while the batch ran.
      const latest = await cache.get(id);
      if (!latest || !needsCategories(latest)) {
        skipped++;
        continue;
      }
      await cache.set({ ...latest, bookCategories });
      saved++;
      console.log(`saved ${id} (${latest.title}${latest.subtitle ? `, ${latest.subtitle}` : ""}): ${bookCategories.join(", ")}`);
    } catch (err) {
      failed++;
      console.warn(`failed ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone: ${saved} saved, ${skipped} skipped (categories added meanwhile), ${failed} failed, cost≈$${cost.toFixed(4)}.`);
  if (saved) console.log("Restart the server, so the title list includes the categories.");
}

function intArg(args: string[], name: string): number | null {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const n = Number(args[at + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number above 0`);
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const resumeAt = args.indexOf("--resume");
  if (resumeAt >= 0) {
    const batchId = args[resumeAt + 1];
    if (!batchId) throw new Error("--resume needs a batch id");
    const client = getClient();
    await waitForBatch(client, batchId);
    await saveResults(client, batchId);
    return;
  }

  const all = await cache.listAll();
  const missing = all.filter(needsCategories).sort((a, b) => a.id.localeCompare(b.id));
  const limit = intArg(args, "--limit");
  const todo = limit ? missing.slice(0, limit) : missing;
  console.log(`${all.length} saved results in ${config.cacheDir}; ${missing.length} books without categories.`);
  if (!todo.length) {
    console.log("Nothing to do.");
    return;
  }

  const requests = todo.map((r) => ({ custom_id: r.id, params: buildBookCategoriesRequest(r) }));
  // About 1,200 input and 400 output tokens each (answer and thinking) on Haiku 5.5, at batch prices.
  const usage = { input_tokens: 1200, output_tokens: 400 };
  const estimate = requests.length * (estimateCost({ id: "estimate", mode: "batch", model: config.model, usage }) ?? 0);
  console.log(`${requests.length} books to categorize. Estimated cost ≈ $${estimate.toFixed(2)} at batch prices.`);
  if (args.includes("--dry-run")) {
    console.log("Dry run: no batch sent. First titles:");
    for (const r of todo.slice(0, 5)) console.log(`  ${r.id} (${r.title}${r.subtitle ? `, ${r.subtitle}` : ""})`);
    return;
  }

  const client = getClient();
  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch ${batch.id} sent. If this script stops, run: npm run backfill:book-categories -- --resume ${batch.id}`);
  await waitForBatch(client, batch.id);
  await saveResults(client, batch.id);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
