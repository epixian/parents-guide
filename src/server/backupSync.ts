// Compare CACHE_DIR with the backup bucket and copy what is missing.
//
// Usage:
//   npm run backup:sync [-- --dry-run]       upload local files that are missing or differ in size
//   npm run backup:sync -- --restore [--dry-run]
//                                            download objects that are missing locally (never overwrites)
//
// The server and the batch script upload each result as it is saved; use this
// for the first full upload, after a time with uploads off, and to restore.
// Restart the server after a restore so it reads the restored files.

import fs from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { isBackedUp, objectKey, s3Client, uploadFile } from "./backup.js";
import { config } from "./config.js";

const CONCURRENCY = 8;

async function localFiles(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const entries = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
  for (const rel of entries) {
    if (!isBackedUp(rel)) continue;
    const stat = await fs.stat(path.join(root, rel)).catch(() => null);
    if (stat?.isFile()) out.set(rel.split(path.sep).join("/"), stat.size);
  }
  return out;
}

async function main(): Promise<void> {
  const s3 = config.s3;
  if (!s3) throw new Error("The backup is off: S3_BUCKET is not set, or a setting is bad (see the warning above).");
  const args = process.argv.slice(2);
  const restore = args.includes("--restore");
  const dryRun = args.includes("--dry-run");
  const client = await s3Client(s3);
  const root = config.cacheDir;

  // Object sizes by path inside CACHE_DIR.
  const remote = new Map<string, number>();
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: s3.prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      const rel = o.Key!.slice(s3.prefix.length);
      if (isBackedUp(rel)) remote.set(rel, o.Size ?? 0);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const local = await localFiles(root);
  console.log(`Local: ${local.size} files in ${root}. Bucket: ${remote.size} objects in s3://${s3.bucket}/${s3.prefix}`);

  const todo = restore
    ? [...remote.keys()].filter((rel) => !local.has(rel))
    : [...local.entries()].filter(([rel, size]) => remote.get(rel) !== size).map(([rel]) => rel);
  console.log(`${todo.length} file(s) to ${restore ? "download" : "upload"}.`);
  if (dryRun || !todo.length) return;

  let done = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) {
        const rel = todo[next++]!;
        try {
          if (restore) {
            const res = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: objectKey(s3, rel) }));
            const file = path.join(root, rel);
            await fs.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(tmp, await res.Body!.transformToByteArray());
            await fs.rename(tmp, file);
          } else {
            await uploadFile(client, s3, root, rel);
          }
          if (++done % 100 === 0) console.log(`${done} / ${todo.length}`);
        } catch (err) {
          failed++;
          console.warn(`failed ${rel}: ${(err as Error).message}`);
        }
      }
    }),
  );
  console.log(`Done: ${done} ${restore ? "downloaded" : "uploaded"}, ${failed} failed.`);
  if (restore && done) console.log("Restart the server so it reads the restored files.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
