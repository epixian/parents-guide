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
  // Localhost only by default: Nginx (or the Vite dev proxy) is the only
  // client. Reached directly, a client could fake X-Forwarded-For and get
  // around the per-IP AI limit when TRUST_PROXY=1.
  host: process.env.HOST || "127.0.0.1",
  cacheDir: path.resolve(process.env.CACHE_DIR || "./data/cache"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  aiLookupsPerIpPerHour: intEnv("AI_LOOKUPS_PER_IP_PER_HOUR", 30),
  trustProxy: process.env.TRUST_PROXY === "1",
  // Contact URL or email for the Open Library User-Agent. With a contact,
  // Open Library allows about 3 requests per second; without one, about 1.
  openLibraryContact: process.env.OPENLIBRARY_CONTACT || "",
  model: "claude-haiku-4-5",
};
