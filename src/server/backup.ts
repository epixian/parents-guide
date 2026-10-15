import fs from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config, type S3Config } from "./config.js";

// Off-site copy of CACHE_DIR in any S3-compatible bucket (AWS S3,
// DigitalOcean Spaces, Cloudflare R2, Backblaze B2, MinIO). Off when
// S3_BUCKET is not set.
//
// The local disk stays the source of truth: every read uses it. Each saved
// result is queued for upload right after it is written, so a lost disk loses
// at most a few seconds of work. Failed uploads are retried; they never fail a
// request. The object key is S3_PREFIX + the path inside CACHE_DIR, so a
// restore is a download into CACHE_DIR (see backupSync.ts).

/** Files inside CACHE_DIR that are backed up; batch-catalog/ is a disposable copy of catalog data. */
export function isBackedUp(rel: string): boolean {
  const top = rel.split(/[\\/]/)[0];
  return (
    ((top === "movie" || top === "tv" || top === "book") && rel.endsWith(".json")) ||
    rel === "popularity.json" ||
    rel === "usage.jsonl"
  );
}

/** Object key for a path inside CACHE_DIR. Keys always use forward slashes. */
export const objectKey = (s3: S3Config, rel: string) => `${s3.prefix}${rel.split(path.sep).join("/")}`;

const contentType = (rel: string) => (rel.endsWith(".jsonl") ? "application/x-ndjson" : "application/json");

export function s3Client(s3: S3Config): S3Client {
  return new S3Client({
    region: s3.region,
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  });
}

/** Upload one file from CACHE_DIR. Reads the file at upload time, so the newest version goes up. */
export async function uploadFile(client: S3Client, s3: S3Config, root: string, rel: string): Promise<void> {
  const body = await fs.readFile(path.join(root, rel));
  await client.send(
    new PutObjectCommand({ Bucket: s3.bucket, Key: objectKey(s3, rel), Body: body, ContentType: contentType(rel) }),
  );
}

/** Uploads at a time. */
const CONCURRENCY = 4;
/** Waits before retrying a failed upload; after the last one, the file waits for the next retry round. */
const RETRY_WAITS_MS = [2_000, 10_000, 60_000];

export class Backup {
  private readonly client: S3Client;
  /** Paths waiting for upload. A path queued twice uploads once. */
  private readonly pending = new Set<string>();
  /** Paths that failed every retry. They go back in the queue on the next queue() call or flush(). */
  private readonly failed = new Set<string>();
  private running = 0;
  private idle: (() => void)[] = [];

  constructor(
    private readonly s3: S3Config,
    private readonly root: string,
  ) {
    this.client = s3Client(s3);
  }

  /** Queue a path inside CACHE_DIR for upload. Paths that are not backed up are ignored. */
  queue(rel: string): void {
    if (!isBackedUp(rel)) return;
    for (const f of this.failed) this.pending.add(f);
    this.failed.clear();
    this.pending.add(rel);
    this.pump();
  }

  /** Wait until the queue is empty (for shutdown and the end of a batch run). Gives up after timeoutMs. */
  async flush(timeoutMs = 30_000): Promise<void> {
    for (const f of this.failed) this.pending.add(f);
    this.failed.clear();
    this.pump();
    if (!this.running && !this.pending.size) return;
    await Promise.race([
      new Promise<void>((resolve) => this.idle.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    if (this.pending.size || this.running) console.warn(`Backup: ${this.pending.size + this.running} upload(s) not finished`);
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.pending.size) {
      const rel = this.pending.values().next().value!;
      this.pending.delete(rel);
      this.running++;
      void this.upload(rel).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.pending.size) this.idle.splice(0).forEach((resolve) => resolve());
      });
    }
  }

  private async upload(rel: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await uploadFile(this.client, this.s3, this.root, rel);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // Deleted meanwhile: nothing to copy.
        const wait = RETRY_WAITS_MS[attempt];
        if (wait === undefined) {
          console.warn(`Backup: upload of ${rel} failed, will retry later: ${(err as Error).message}`);
          this.failed.add(rel);
          return;
        }
        // unref: a retry wait does not keep a finished batch script running.
        await new Promise((resolve) => setTimeout(resolve, wait).unref());
      }
    }
  }
}

/** The backup for this process, or null when S3_BUCKET is not set. */
export const backup: Backup | null = config.s3 ? new Backup(config.s3, config.cacheDir) : null;
