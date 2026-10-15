import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Short git commit of the checkout, or "unknown" outside a git checkout. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

// package.json is two levels up from both src/server/ and dist/server/.
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string };

/** S3-compatible bucket for the off-site copy of CACHE_DIR (see backup.ts). */
export interface S3Config {
  /** Empty for AWS S3; e.g. https://nyc3.digitaloceanspaces.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix, e.g. "cache/". Empty or ending in "/". */
  prefix: string;
  /** Path-style URLs (bucket in the path). Needed by MinIO and some other services. */
  forcePathStyle: boolean;
}

function s3Config(): S3Config | null {
  const bucket = process.env.S3_BUCKET || "";
  if (!bucket) return null;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || "";
  if (!accessKeyId || !secretAccessKey) throw new Error("S3_BUCKET is set, so S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
  const prefix = (process.env.S3_PREFIX || "").replace(/^\/+/, "");
  return {
    endpoint: process.env.S3_ENDPOINT || "",
    // Most S3-compatible services ignore the region; "us-east-1" is the usual placeholder.
    region: process.env.S3_REGION || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
  };
}

export const config = {
  // App name and commit, for the User-Agent of catalog requests.
  appName: pkg.name,
  appCommit: gitCommit(),
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
  /** Off-site backup bucket, or null when S3_BUCKET is not set. */
  s3: s3Config(),
};
