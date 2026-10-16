import { promisify } from "node:util";
import zlib from "node:zlib";

const brotliCompress = promisify(zlib.brotliCompress);

/**
 * One Brotli copy (quality 11) of a large response that changes now and then,
 * such as GET /api/titles. Quality 11 is about a third smaller than nginx's
 * gzip, but takes a few seconds for 2 MB, so it runs in the background, once
 * per version. Until the copy is ready, callers send the plain body and nginx
 * gzips it. nginx does not compress a response that is already compressed.
 */
export class BrotliCache {
  private ready: { key: string; body: Buffer } | null = null;
  private working = false;

  /** The compressed body for this key, or null when it is not ready. Starts the work if none runs. */
  get(key: string, text: () => string): Buffer | null {
    if (this.ready?.key === key) return this.ready.body;
    if (!this.working) void this.compress(key, text());
    return null;
  }

  private async compress(key: string, text: string): Promise<void> {
    this.working = true;
    try {
      const body = await brotliCompress(text, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
        },
      });
      this.ready = { key, body };
    } catch (err) {
      console.error("Brotli compression failed:", err);
    } finally {
      this.working = false;
    }
  }
}

/** True when the Accept-Encoding header allows Brotli ("br", and not "br;q=0"). */
export function acceptsBrotli(header: string | undefined): boolean {
  return (header ?? "").split(",").some((part) => {
    const [name, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    return name === "br" && (!q || Number(q.slice(2)) > 0);
  });
}
