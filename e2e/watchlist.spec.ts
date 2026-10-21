import { expect, test } from "@playwright/test";
import type { IndexEntry } from "../src/shared/types.js";
import { entry, ratedTitles, ready, setUp } from "./helpers.js";

// The watchlist: the card button, the home page row, and the watchlist page
// with its "On my services" filter.

/** n rated movies, oldest added first in the watchlist (the page shows the newest first). */
function watchlistOf(items: IndexEntry[]) {
  return Object.fromEntries(items.map((t, i) => [t.id, entry(t, new Date(Date.UTC(2026, 0, 1 + i)).toISOString())]));
}

test("the bookmark on a card adds the title to the watchlist", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/browse?kind=movie&sort=title");
  await ready(page);
  const card = page.locator("#browse-results .cards > li").first();
  const title = (await card.locator(".card-title").textContent())!;
  const button = card.locator('[data-card-action="list"]');
  await card.hover();
  await button.click();
  await expect(card.locator('[data-card-action="list"]')).toHaveAttribute("aria-pressed", "true");

  await page.goto("/#/watchlist");
  await expect(page.locator("#watchlist-count")).toHaveText("1 title, most recently added first.");
  await expect(page.locator("#watchlist-grid .card-title")).toHaveText([title]);
  expect(errors).toEqual([]);
});

test("the home page shows the newest 8, with a link to the rest", async ({ page, request }) => {
  const movies = (await ratedTitles(request)).filter((t) => t.kind === "movie").slice(0, 10);
  const errors = await setUp(page, { watchlist: watchlistOf(movies) });
  await page.goto("/");
  const row = page.locator("section.watchlist");
  await expect(row.getByRole("heading", { name: "My watchlist" })).toBeVisible();
  await expect(row.locator(".cards > li")).toHaveCount(8);
  // Newest first.
  await expect(row.locator(".card-title").first()).toHaveText(movies[9]!.title);

  await row.getByRole("link", { name: "Show all 10 →" }).click();
  await expect(page).toHaveURL(/#\/watchlist$/);
  await expect(page.locator("#watchlist-grid > li")).toHaveCount(10);
  await expect(page.locator("#watchlist-count")).toHaveText("10 titles, most recently added first.");
  expect(errors).toEqual([]);
});

test("removing a title on the watchlist page takes it out of the grid", async ({ page, request }) => {
  const movies = (await ratedTitles(request)).filter((t) => t.kind === "movie").slice(0, 2);
  const errors = await setUp(page, { watchlist: watchlistOf(movies) });
  await page.goto("/#/watchlist");
  const grid = page.locator("#watchlist-grid");
  await expect(grid.locator("> li")).toHaveCount(2);
  const card = grid.locator("> li").first();
  await card.hover();
  await card.locator('[data-card-action="list"]').click();
  await expect(grid.locator("> li")).toHaveCount(1);
  await expect(page.locator("#watchlist-count")).toHaveText("1 title, most recently added first.");

  const last = grid.locator("> li").first();
  await last.hover();
  await last.locator('[data-card-action="list"]').click();
  await expect(page.locator("#watchlist-count")).toHaveText("Your watchlist is empty.");
  expect(errors).toEqual([]);
});

test("an empty watchlist says how to add titles", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/watchlist");
  await expect(page.getByText("Your watchlist is empty. Select the bookmark on a title's page to add it.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "On my services" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("On my services filters the watchlist page", async ({ page, request }) => {
  const titles = await ratedTitles(request);
  // One title on a service the user has, one on services the user does not
  // have, one with no services, and a book.
  const mine = titles.find((t) => t.kind !== "book" && t.providers?.length);
  const other = titles.find((t) => t.kind !== "book" && t.providers?.length && t.providers.every((id) => !mine?.providers?.includes(id)));
  const none = titles.find((t) => t.kind === "movie" && !t.providers?.length);
  const book = titles.find((t) => t.kind === "book");
  test.skip(!mine || !other || !none || !book, "The rated titles do not have the services this test needs.");

  const errors = await setUp(page, {
    watchlist: watchlistOf([mine!, other!, none!, book!]),
    hiddenProviders: other!.providers!,
  });
  await page.goto("/#/watchlist");
  const grid = page.locator("#watchlist-grid");
  const count = page.locator("#watchlist-count");
  await expect(grid.locator("> li")).toHaveCount(4);

  const filter = page.getByRole("checkbox", { name: "On my services" });
  await filter.check();
  await expect(page).toHaveURL(/#\/watchlist\?streaming=mine$/);
  await expect(grid.locator(".card-title")).toHaveText([mine!.title]);
  await expect(count).toHaveText("1 of 4 titles stream on my services, most recently added first.");

  // The filter stays after a reload.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "On my services" })).toBeChecked();
  await expect(grid.locator(".card-title")).toHaveText([mine!.title]);

  // Removing the only match.
  const card = grid.locator("> li").first();
  await card.hover();
  await card.locator('[data-card-action="list"]').click();
  await expect(count).toHaveText("None of the 3 titles stream on my services.");

  // Off: every title shows again.
  await page.getByRole("checkbox", { name: "On my services" }).uncheck();
  await expect(page).toHaveURL(/#\/watchlist$/);
  await expect(grid.locator("> li")).toHaveCount(3);
  await expect(count).toHaveText("3 titles, most recently added first.");
  expect(errors).toEqual([]);
});
