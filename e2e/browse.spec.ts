import { expect, test, type Page } from "@playwright/test";
import { ratedTitles, ready, setUp } from "./helpers.js";

// The Browse page: filters in the URL, sort, "Show more", and the services filter.

const count = async (page: Page) => {
  const text = page.locator("#browse-count");
  await expect(text).toHaveText(/^\d+ titles?$/);
  await expect(page.locator("#browse-results")).not.toHaveAttribute("aria-busy", "true");
  return parseInt((await text.textContent())!, 10);
};

test("Browse lists every rated title, and the type filters go in the URL", async ({ page, request }) => {
  const errors = await setUp(page);
  const titles = await ratedTitles(request);
  await page.goto("/browse");
  await ready(page);
  expect(await count(page)).toBe(titles.length);

  // Books only.
  const form = page.locator("#browse-form");
  await form.getByRole("checkbox", { name: "Movies" }).uncheck();
  await form.getByRole("checkbox", { name: "TV shows" }).uncheck();
  await expect(page).toHaveURL(/kind=book/);
  expect(await count(page)).toBe(titles.filter((t) => t.kind === "book").length);
  const hrefs = await page.locator("#browse-results .cards > li > a").evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  for (const href of hrefs) expect(href).toMatch(/^\/book\/OL\d+W/);

  // The last type cannot be turned off.
  await form.getByRole("checkbox", { name: "Books" }).click();
  await expect(form.getByRole("checkbox", { name: "Books" })).toBeChecked();

  // The URL keeps the filters on reload.
  await page.reload();
  await expect(page.locator("#browse-form").getByRole("checkbox", { name: "Movies" })).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("a book's category links open Browse with that category", async ({ page, request }) => {
  const errors = await setUp(page);
  const titles = await ratedTitles(request);
  const book = titles.find((t) => t.bookCategories?.length);
  test.skip(!book, "No saved book has categories yet (npm run backfill:book-categories:dev)");
  const id = book!.bookCategories![0]!;
  await page.goto(`/book/${book!.id.slice("ol-".length)}`);
  await ready(page);
  const links = page.locator("#sec-details dd a[href^='/browse#book=']");
  await expect(links).toHaveCount(book!.bookCategories!.length);

  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`/browse#book=${id}$`));
  expect(await count(page)).toBe(titles.filter((t) => t.bookCategories?.includes(id)).length);
  await expect(page.locator(`#browse-book input[value="${id}"]`)).toBeChecked();
  await expect(page.locator("#book-count")).toHaveText("(1 selected)");
  expect(errors).toEqual([]);
});

test("the title filter and Clear filters", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/browse");
  await ready(page);
  const all = await count(page);
  await page.locator("#browse-form").getByPlaceholder("Title contains").fill("matrix");
  await expect(page).toHaveURL(/q=matrix/);
  const matches = await count(page);
  expect(matches).toBeGreaterThan(0);
  expect(matches).toBeLessThan(all);
  for (const title of await page.locator("#browse-results .card-title").allTextContents()) expect(title.toLowerCase()).toContain("matrix");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/:\d+\/browse$/);
  await expect(page.locator("#browse-form").getByPlaceholder("Title contains")).toHaveValue("");
  expect(await count(page)).toBe(all);
  expect(errors).toEqual([]);
});

test("sort by title, and Randomize for the random order", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/browse#kind=movie");
  await ready(page);
  const sort = page.locator("#browse-form select[name=sort]");
  await sort.selectOption("title");
  await expect(page).toHaveURL(/sort=title/);
  await count(page);
  const titles = await page.locator("#browse-results .card-title").allTextContents();
  expect(titles.length).toBeGreaterThan(1);
  // The same compare as src/shared/browse.ts.
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));

  const shuffle = page.getByRole("button", { name: "Randomize" });
  await expect(shuffle).toBeHidden();
  await sort.selectOption("random");
  await expect(shuffle).toBeVisible();
  await expect(page).toHaveURL(/seed=\d+/);
  const seed = /seed=(\d+)/.exec(page.url())![1];
  await shuffle.click();
  await expect(page).not.toHaveURL(new RegExp(`seed=${seed}\\b`));
  expect(errors).toEqual([]);
});

test("Show more adds the next page of cards", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/browse");
  await ready(page);
  await count(page);
  const cards = page.locator("#browse-results .cards > li");
  const first = await cards.count();
  const more = page.locator("#browse-results button[data-more]");
  // The button loads on its own as it comes near the screen; a click also works.
  if (await more.isVisible()) await more.click().catch(() => {});
  await expect.poll(() => cards.count()).toBeGreaterThan(first);
  expect(errors).toEqual([]);
});

test("On my services shows only titles on a service the user has", async ({ page, request }) => {
  const titles = await ratedTitles(request);
  // Keep Netflix (id 8) only: hide every other service id in the catalog.
  const all = new Set(titles.flatMap((t) => t.providers ?? []));
  const hidden = [...all].filter((id) => id !== 8);
  const expected = titles.filter((t) => t.providers?.includes(8)).length;
  test.skip(!expected, "No rated title streams on Netflix just now.");

  const errors = await setUp(page, { hiddenProviders: hidden });
  await page.goto("/browse");
  await ready(page);
  await page.locator("#browse-form").getByRole("checkbox", { name: "On my services" }).check();
  await expect(page).toHaveURL(/streaming=mine/);
  // The hidden services are sent with the request, not put in the page URL.
  expect(page.url()).not.toContain("hideService");
  expect(await count(page)).toBe(expected);
  expect(errors).toEqual([]);
});

test("with data saver, Browse still filters in the browser and sends no limits or services", async ({ page }) => {
  const errors = await setUp(page, { concernLimits: { max: { violence: 0 }, hide: {} }, hiddenProviders: [8] });
  await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
  const sent: string[] = [];
  page.on("request", (req) => {
    if (/[?&](max\.|hide\.|hideService)/.test(req.url())) sent.push(req.url());
  });
  await page.goto("/browse#streaming=mine");
  await ready(page);
  await expect(page.locator("#browse-count")).toHaveText(/^\d+ titles?$/);
  await expect(page.locator("#over-text")).toHaveText(/over my concern limits$/);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
