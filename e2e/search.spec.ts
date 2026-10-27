import { expect, test } from "@playwright/test";
import { MATRIX, ready, setUp } from "./helpers.js";

// The search box suggestions and the search results page.

test("suggestions show rated titles as the user types, and open one with the keyboard", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  const input = page.locator("#search-input");
  await input.click();
  await input.pressSequentially("the matrix", { delay: 30 });
  const list = page.locator("#suggestions");
  await expect(list).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  const matrix = list.getByRole("option", { name: /^The Matrix \(1999\)/ });
  await expect(matrix).toBeVisible();
  // The last row searches the catalogs.
  await expect(list.getByRole("option").last()).toContainText("Search all movies, TV shows, and books");

  // Arrow down to The Matrix, then Enter opens its page.
  const options = await list.getByRole("option").allTextContents();
  const index = options.findIndex((text) => /^\s*The Matrix\s+\(1999\)/.test(text));
  expect(index).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= index; i++) await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", `suggestion-${index}`);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/r/${MATRIX}$`));
  await expect(page.getByRole("heading", { level: 1, name: /The Matrix/ })).toBeVisible();
  await expect(list).toBeHidden();
  expect(errors).toEqual([]);
});

test("Escape closes the suggestions and keeps the text", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  const input = page.locator("#search-input");
  await input.click();
  await input.pressSequentially("die hard", { delay: 30 });
  await expect(page.locator("#suggestions")).toBeVisible();
  await input.press("Escape");
  await expect(page.locator("#suggestions")).toBeHidden();
  await expect(input).toHaveValue("die hard");
  expect(errors).toEqual([]);
});

test("the results page lists rated titles first, with type filters", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  await page.locator("#search-input").fill("matrix");
  await page.locator("#search-input").press("Enter");
  await expect(page).toHaveURL(/#\/search\?q=matrix$/);
  await expect(page.getByRole("heading", { level: 1, name: 'Results for "matrix"' })).toBeVisible();

  const results = page.locator("#search-results");
  // Rated titles show at once, with the "Rated" badge.
  const matrix = results.locator(".results > li", { has: page.locator(`a[href="#/r/${MATRIX}"]`) });
  await expect(matrix).toBeVisible();
  await expect(matrix.locator(".badge.rated")).toHaveText("Rated");

  // Wait for the catalog search (TMDB and Open Library) to finish.
  await expect(results).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
  const all = results.locator('button[data-filter="all"]');
  await expect(all).toHaveAttribute("aria-pressed", "true");

  // "Movies" shows only the movie group, and the choice is remembered.
  await results.locator('button[data-filter="movie"]').click();
  await expect(results.locator('button[data-filter="movie"]')).toHaveAttribute("aria-pressed", "true");
  await expect(results.locator('.result-group[data-kind="movie"]')).toBeVisible();
  for (const kind of ["tv", "book"]) {
    const group = results.locator(`.result-group[data-kind="${kind}"]`);
    if (await group.count()) await expect(group).toBeHidden();
  }
  expect(await page.evaluate(() => localStorage.getItem("searchFilter"))).toBe("movie");

  await all.click();
  await expect(results.locator('.result-group[data-kind="movie"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("a search with no matches says so", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/search?q=zzqxjvwplk");
  await expect(page.locator("#search-results")).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
  await expect(page.getByText("No matches. Try another spelling.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("when the rated list does not load, it is not loaded again at once, and popular titles are not called \"Not rated yet\"", async ({ page }) => {
  const errors = await setUp(page);
  let loads = 0;
  await page.route("**/api/titles**", (route) => {
    loads++;
    return route.fulfill({ status: 500 });
  });
  await page.route("**/api/catalog", (route) => route.fulfill({ json: { movie: [[603, "The Matrix", 1999]], tv: [] } }));
  await page.goto("/");
  const input = page.locator("#search-input");
  await input.click();
  await input.pressSequentially("the matrix", { delay: 30 });
  const matrix = page.locator("#suggestions").getByRole("option", { name: /^The Matrix \(1999\)/ });
  await expect(matrix).toBeVisible();
  await expect(matrix.locator(".unrated")).toHaveCount(0);
  // One failed load, not one per pause in typing: the next try waits 30 seconds.
  expect(loads).toBe(1);
  expect(errors).toEqual([]);
});

test("with data saver, suggestions still come from the browser, and the typed text is not sent", async ({ page }) => {
  const errors = await setUp(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
  const sent: string[] = [];
  page.on("request", (req) => {
    if (/matrix/i.test(req.url())) sent.push(req.url());
  });
  await page.goto("/");
  await ready(page);
  const input = page.locator("#search-input");
  await input.click();
  await input.pressSequentially("the matrix", { delay: 30 });
  await expect(page.locator("#suggestions").getByRole("option", { name: /^The Matrix \(1999\)/ })).toBeVisible();
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
