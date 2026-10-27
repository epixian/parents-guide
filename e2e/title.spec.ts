import { expect, test } from "@playwright/test";
import { DIE_HARD, MATRIX, TED_LASSO, ready, setUp } from "./helpers.js";

// Title pages: a rated movie, a TV series and its season, and the user's marks.

test("a movie page shows the ratings, summary, streaming, and similar titles", async ({ page, request }) => {
  const errors = await setUp(page);
  await page.goto(`/r/${MATRIX}`);
  await expect(page.getByRole("heading", { level: 1, name: /The Matrix/ })).toBeVisible();

  const ratings = page.locator("#sec-ratings table.ratings");
  await expect(ratings.getByRole("rowheader", { name: "Violence" })).toBeVisible();
  await expect(page.locator("#sec-summary")).toBeVisible();
  await expect(page.locator("#sec-details")).toBeVisible();
  await expect(page.locator("nav.jumps button[data-jump=sec-ratings]")).toBeVisible();

  // The streaming line shows each service the title streams on.
  const watch = (await (await request.get(`/api/watch/${MATRIX}`)).json()) as { providers: unknown[] };
  const slot = page.locator("#watch-slot");
  await expect(slot).not.toHaveAttribute("aria-busy", "true");
  if (watch.providers.length) await expect(slot.locator(".watch-list li").first()).toBeVisible();
  else await expect(slot).toBeHidden();

  // Similar titles load after the page, or the section leaves when there are none.
  const similar = page.locator("#sec-similar");
  await expect(page.locator("#similar-slot[aria-busy]")).toHaveCount(0, { timeout: 30_000 });
  if (await similar.count()) await expect(similar.locator(".cards > li").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a jump link scrolls to its section", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto(`/r/${MATRIX}`);
  await ready(page);
  await page.locator("nav.jumps button[data-jump=sec-details]").first().click();
  await expect(page.locator("#sec-details")).toBeInViewport();
  expect(errors).toEqual([]);
});

test("the watchlist button and thumbs on a title page are saved", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto(`/r/${DIE_HARD}`);
  await ready(page);
  const marks = page.locator("#marks");
  const list = marks.locator('[data-mark="list"]');
  const up = marks.locator('[data-mark="up"]');
  const down = marks.locator('[data-mark="down"]');

  await list.click();
  await expect(list).toHaveAttribute("aria-pressed", "true");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  // One thumb turns the other off.
  await down.click();
  await expect(down).toHaveAttribute("aria-pressed", "true");
  await expect(up).toHaveAttribute("aria-pressed", "false");

  // The choices stay after a reload.
  await page.reload();
  await ready(page);
  await expect(page.locator('#marks [data-mark="list"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('#marks [data-mark="down"]')).toHaveAttribute("aria-pressed", "true");
  const saved = await page.evaluate(() => ({
    watchlist: JSON.parse(localStorage.getItem("watchlist") ?? "{}") as Record<string, { title: string }>,
    thumbs: JSON.parse(localStorage.getItem("thumbs") ?? "{}") as Record<string, string>,
  }));
  expect(saved.watchlist[DIE_HARD]?.title).toBe("Die Hard");
  expect(saved.thumbs[DIE_HARD]).toBe("down");

  // Selecting a thumb again clears it.
  await page.locator('#marks [data-mark="down"]').click();
  await expect(page.locator('#marks [data-mark="down"]')).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
});

test("a TV series page lists its seasons and opens a rated season", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto(`/tv/${TED_LASSO}`);
  await expect(page.getByRole("heading", { level: 1, name: /Ted Lasso/ })).toBeVisible();
  await expect(page.locator("#sec-ratings")).toBeVisible();

  const view = page.getByRole("link", { name: "View rating" }).first();
  await expect(view).toBeVisible();
  // Do not select "Rate this season": that asks the AI for a new rating.
  await view.click();
  await expect(page).toHaveURL(new RegExp(`/r/tmdb-tv-${TED_LASSO}-s\\d+$`));
  await expect(page.getByRole("heading", { level: 1, name: /Ted Lasso/ })).toBeVisible();
  await page.getByRole("link", { name: "← All seasons" }).click();
  await expect(page).toHaveURL(new RegExp(`/tv/${TED_LASSO}$`));
  expect(errors).toEqual([]);
});

test("a TV season's marks use the series", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto(`/r/tmdb-tv-${TED_LASSO}-s01`);
  await ready(page);
  await page.locator('#marks [data-mark="list"]').click();
  const saved = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("watchlist") ?? "{}") as object));
  expect(saved).toEqual([`tmdb-tv-${TED_LASSO}`]);
  expect(errors).toEqual([]);
});
