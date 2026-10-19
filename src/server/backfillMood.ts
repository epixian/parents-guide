// Add a mood (tone, feeling, depth) to saved results that do not have a complete one, at batch prices (50% off).
//
// Usage:
//   npm run backfill:mood -- [--dry-run] [--limit N]
//   npm run backfill:mood -- --resume <batch-id>
//
// It reads every saved result in CACHE_DIR, sends the light mood prompt for
// each one without a mood (see buildMoodRequest in classify.ts), waits for the
// batch, and writes only the mood into each file. Other fields, including
// refreshedAt, stay as they are. The server also adds a missing mood when a
// visitor opens the title, so this script is optional: it fills the rest.
//
// Report pages read the files on each request, so no restart is needed.

import type Anthropic from "@anthropic-ai/sdk";
import { hasMood } from "../shared/mood.js";
import { waitForBatch } from "./batchApi.js";
import { FileReportCache } from "./cache.js";
import { buildMoodRequest, getClient, moodFromMessage } from "./classify.js";
import { config } from "./config.js";
import { estimateCost, recordUsage } from "./usage.js";

const cache = new FileReportCache(config.cacheDir);

/** Write the mood of each successful result into its file, unless the file has one by now. */
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
      const mood = moodFromMessage(message);
      // Read the file again now: the server may have changed it while the batch ran.
      const latest = await cache.get(id);
      if (!latest || hasMood(latest)) {
        skipped++;
        continue;
      }
      await cache.set({ ...latest, mood });
      saved++;
      console.log(
        `saved ${id} (${latest.title}${latest.subtitle ? `, ${latest.subtitle}` : ""}): ` +
          `tone ${mood.tone}, feeling ${mood.feeling}, depth ${mood.depth}. ${mood.note}`,
      );
    } catch (err) {
      failed++;
      console.warn(`failed ${id}: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone: ${saved} saved, ${skipped} skipped (mood added meanwhile), ${failed} failed, cost≈$${cost.toFixed(4)}.`);
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
  const missing = all.filter((r) => !hasMood(r)).sort((a, b) => a.id.localeCompare(b.id));
  const limit = intArg(args, "--limit");
  const todo = limit ? missing.slice(0, limit) : missing;
  console.log(`${all.length} saved results in ${config.cacheDir}; ${missing.length} without a mood.`);
  if (!todo.length) {
    console.log("Nothing to do.");
    return;
  }

  const requests = todo.map((r) => ({ custom_id: r.id, params: buildMoodRequest(r) }));
  // About 1,300 input and 400 output tokens each (answer and thinking) on Haiku 5.5, at batch prices.
  const usage = { input_tokens: 1300, output_tokens: 400 };
  const estimate = requests.length * (estimateCost({ id: "estimate", mode: "batch", model: config.model, usage }) ?? 0);
  console.log(`${requests.length} moods to rate. Estimated cost ≈ $${estimate.toFixed(2)} at batch prices.`);
  if (args.includes("--dry-run")) {
    console.log("Dry run: no batch sent. First titles:");
    for (const r of todo.slice(0, 5)) console.log(`  ${r.id} (${r.title}${r.subtitle ? `, ${r.subtitle}` : ""})`);
    return;
  }

  const client = getClient();
  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch ${batch.id} sent. If this script stops, run: npm run backfill:mood -- --resume ${batch.id}`);
  await waitForBatch(client, batch.id);
  await saveResults(client, batch.id);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
