import { expect, test } from "@playwright/test";
import { setUp } from "./helpers.js";

// The "Recommended for you" row on the home page and the full recommendations page.

/** Action movies liked, romances disliked (as in taste.spec.ts). */
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
} as const;

test("the home row links to the full recommendations page", async ({ page }) => {
  const errors = await setUp(page, { thumbs });
  await page.goto("/");
  const row = page.locator("section.recommended");
  await expect(row.getByRole("heading", { name: "Recommended for you" })).toBeVisible();
  await expect(row.locator(".cards > li")).toHaveCount(12);
  const first = await row.locator(".card-title").first().textContent();

  await row.getByRole("link", { name: "Show more recommendations →" }).click();
  await expect(page).toHaveURL(/#\/recommended$/);
  await expect(page.getByRole("heading", { level: 1, name: "Recommended for you" })).toBeVisible();
  const grid = page.locator("#recommended-grid > li");
  expect(await grid.count()).toBeGreaterThan(12);
  expect(await grid.count()).toBeLessThanOrEqual(100);
  // The page starts with the same best match as the row.
  await expect(page.locator("#recommended-grid .card-title").first()).toHaveText(first!);
  await expect(page.locator("#recommended-count")).toHaveText(
    new RegExp(`^${await grid.count()} titles picked from your thumbs up and down, best match first\\.$`),
  );
  // Thumbed titles are never recommended.
  for (const id of Object.keys(thumbs)) await expect(page.locator(`#recommended-grid [data-id="${id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Not interested takes a title off the recommendations page", async ({ page }) => {
  const errors = await setUp(page, { thumbs });
  await page.goto("/#/recommended");
  const grid = page.locator("#recommended-grid");
  await expect(grid.locator("> li").first()).toBeVisible();
  const before = await grid.locator("> li").count();
  const card = grid.locator("> li").first();
  const id = (await card.locator(".card-actions").getAttribute("data-id"))!;
  await card.hover();
  await card.locator('[data-card-action="hide"]').click();
  await expect(grid.locator("> li")).toHaveCount(before - 1);
  await expect(grid.locator(`[data-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator("#recommended-count")).toHaveText(new RegExp(`^${before - 1} titles`));
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("notInterested") ?? "{}") as object))).toEqual([id]);

  // It stays out after a reload.
  await page.reload();
  await expect(page.locator("#recommended-grid > li").first()).toBeVisible();
  await expect(page.locator(`#recommended-grid [data-id="${id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a title added to the watchlist leaves the recommendations", async ({ page }) => {
  const errors = await setUp(page, { thumbs });
  await page.goto("/");
  const row = page.locator("section.recommended");
  const card = row.locator(".cards > li").first();
  await expect(card).toBeVisible();
  const id = (await card.locator(".card-actions").getAttribute("data-id"))!;
  await card.hover();
  await card.locator('[data-card-action="list"]').click();
  await expect(page.locator(`section.recommended [data-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator(`section.watchlist [data-id="${id}"]`)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("without a thumbs up, the recommendations page says how to get some", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/recommended");
  await expect(page.getByText("No recommendations yet. Give a title a thumbs up on its page to get some.")).toBeVisible();
  expect(errors).toEqual([]);
});
