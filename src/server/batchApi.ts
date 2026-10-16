import type Anthropic from "@anthropic-ai/sdk";

// Shared by the batch scripts (batch.ts, backfillMood.ts).

const POLL_MS = 15_000;

/** Wait until the batch has ended, printing its status each time it changes. */
export async function waitForBatch(client: Anthropic, batchId: string): Promise<void> {
  let last = "";
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    const c = batch.request_counts;
    const status =
      `${batch.processing_status}: ` +
      `${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored, ${c.expired} expired`;
    // Poll often, but print only when something changed.
    if (status !== last) console.log(`${new Date().toLocaleTimeString()} ${status}`);
    last = status;
    if (batch.processing_status === "ended") return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
