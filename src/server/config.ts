import path from "node:path";

// Load .env from the working directory if it exists (Node 22+).
try {
  process.loadEnvFile();
} catch {
  // No .env file: use the real environment only.
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: intEnv("PORT", 8787),
  cacheDir: path.resolve(process.env.CACHE_DIR || "./data/cache"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  aiLookupsPerIpPerHour: intEnv("AI_LOOKUPS_PER_IP_PER_HOUR", 30),
  trustProxy: process.env.TRUST_PROXY === "1",
  model: "claude-haiku-4-5",
};
