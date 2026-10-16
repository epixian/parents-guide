import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../src/server/http.js";
import { SimilarService } from "../src/server/similar.js";
const LOST_WORLD = "tmdb-movie-330";

test("SimilarService keeps a list for the time limit and gives a season its series' list", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "similar-cache-"));
  const calls: string[] = [];
  const similar = new SimilarService(
    dir,
    async (kind, id) => {
      calls.push(`${kind}-${id}`);
      return [LOST_WORLD];
    },
    1000,
    5000,
  );
  assert.deepEqual(await similar.title("tmdb-movie-329", 0), [LOST_WORLD]);
  await similar.title("tmdb-movie-329", 999);
  await similar.title("tmdb-movie-329", 1000);
  await similar.title("tmdb-tv-1399-s02", 0);
  await similar.title("tmdb-tv-1399", 0);
  assert.deepEqual(calls, ["movie-329", "movie-329", "tv-1399"]);
  await assert.rejects(similar.title("ol-OL82563W"), (err) => err instanceof HttpError && err.status === 400);
  await fs.rm(dir, { recursive: true });
});
