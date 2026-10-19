import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

// Token usage of every AI call: one line in the server log, and one JSON line
// in <CACHE_DIR>/usage.jsonl for totals later (outside git, like the cache).

/**
 * List prices per million tokens (USD). Batch requests cost half. Haiku 5.5:
 * prompts up to 100K tokens (a rating prompt is about 5,000); longer prompts
 * cost $0.50 / $2.50. Haiku 4.5 stays for older lines in usage.jsonl.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface UsageEntry {
  id: string;
  mode: "live" | "batch";
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** Estimated cost in USD, or null for a model without a known price. */
export function estimateCost(e: UsageEntry): number | null {
  const key = Object.keys(PRICES).find((k) => e.model.startsWith(k));
  if (!key) return null;
  const p = PRICES[key]!;
  const u = e.usage;
  const input =
    u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const cost = (input * p.input + u.output_tokens * p.output) / 1_000_000;
  return e.mode === "batch" ? cost / 2 : cost;
}

export async function recordUsage(e: UsageEntry): Promise<void> {
  const cost = estimateCost(e);
  console.log(
    `AI usage ${e.id} (${e.mode}): in=${e.usage.input_tokens} out=${e.usage.output_tokens}` +
      (cost === null ? "" : ` cost≈$${cost.toFixed(4)}`),
  );
  const line = JSON.stringify({
    at: new Date().toISOString(),
    id: e.id,
    mode: e.mode,
    model: e.model,
    input: e.usage.input_tokens,
    output: e.usage.output_tokens,
    cost,
  });
  try {
    await fs.mkdir(config.cacheDir, { recursive: true });
    await fs.appendFile(path.join(config.cacheDir, "usage.jsonl"), `${line}\n`, "utf8");
  } catch (err) {
    console.warn(`Could not write usage log: ${(err as Error).message}`);
  }
}
