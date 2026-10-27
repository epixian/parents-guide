import { expect, test, type Page } from "@playwright/test";

// Recommendations and the fit line, scored by the taste worker (see
// src/client/tasteClient.ts). The thumbs are a fixed test set: action movies
// liked, romances disliked. They need the titles in the local cache.
const thumbs = {
  "tmdb-movie-603": "up", // The Matrix
  "tmdb-movie-562": "up", // Die Hard
  "tmdb-movie-954": "up", // Mission: Impossible
  "tmdb-movie-1637": "up", // Speed
  "tmdb-movie-36557": "up", // Casino Royale
  "tmdb-movie-76341": "up", // Mad Max: Fury Road
  "tmdb-movie-245891": "up", // John Wick
  "tmdb-movie-11036": "down", // The Notebook
  "tmdb-movie-11631": "down", // Mamma Mia!
  "tmdb-movie-4348": "down", // Pride & Prejudice
};
/** An action movie that the thumbs above match strongly. */
const MATCH = "tmdb-movie-1089"; // Point Break

/** Give the page the test thumbs, and collect its errors. */
async function setUp(page: Page, opts: { noWorker?: boolean } = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  await page.addInitScript(
    ({ thumbs, noWorker }) => {
      localStorage.setItem("thumbs", JSON.stringify(thumbs));
      // A browser without workers: the page must score on its own thread.
      if (noWorker) Object.defineProperty(window, "Worker", { value: undefined });
    },
    { thumbs, noWorker: opts.noWorker ?? false },
  );
  return errors;
}

test("the home page shows recommendations, scored in a worker", async ({ page }) => {
  const errors = await setUp(page);
  const worker = page.waitForEvent("worker");
  await page.goto("/");
  await worker;
  const cards = page.locator(".recommended .cards > li");
  await expect(page.getByRole("heading", { name: "Recommended for you" })).toBeVisible();
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);
  // Thumbed titles are never recommended.
  for (const id of Object.keys(thumbs)) await expect(page.locator(`.recommended [data-id="${id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a title page shows the fit line for a strong match", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto(`/r/${MATCH}`);
  const fit = page.locator("#fit");
  await expect(fit).toBeVisible();
  await expect(fit).toContainText(/liked/i);
  expect(errors).toEqual([]);
});

test("without workers, the page scores on its own thread", async ({ page }) => {
  const errors = await setUp(page, { noWorker: true });
  let workers = 0;
  page.on("worker", () => workers++);
  await page.goto("/");
  await expect(page.locator(".recommended .cards > li").first()).toBeVisible();
  await page.goto(`/r/${MATCH}`);
  await expect(page.locator("#fit")).toBeVisible();
  expect(workers).toBe(0);
  expect(errors).toEqual([]);
});
