import { expect, test } from "@playwright/test";
import { MATRIX, ready, setUp } from "./helpers.js";

// The Preferences page: topics, concern limits, and "My services".

test("a hidden topic leaves the title pages", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/preferences");
  await ready(page);
  const row = page.locator('#concerns .concern-row[data-topic="violence"]');
  await row.getByRole("checkbox", { name: "Violence" }).uncheck();
  await expect(row).toHaveClass(/is-hidden/);
  await expect(row.locator("select")).toBeDisabled();

  await page.goto(`/#/r/${MATRIX}`);
  await ready(page);
  const ratings = page.locator("#sec-ratings");
  await expect(ratings.getByRole("rowheader", { name: "Violence" })).toHaveCount(0);
  await expect(ratings).toContainText("1 topic(s) hidden by your preferences.");
  expect(errors).toEqual([]);
});

test("Hide all and Show all change every topic", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/preferences");
  await ready(page);
  const concerns = page.locator("#concerns");
  await concerns.getByRole("button", { name: "Hide all" }).click();
  await expect(concerns.locator("input[data-show]:checked")).toHaveCount(0);

  await page.goto(`/#/r/${MATRIX}`);
  await expect(page.getByText("All topics are hidden.")).toBeVisible();

  await page.goto("/#/preferences");
  await page.locator("#concerns").getByRole("button", { name: "Show all" }).click();
  await expect(page.locator("#concerns input[data-show]:not(:checked)")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a concern limit marks titles over it and filters Browse", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/#/browse");
  await ready(page);
  const count = page.locator("#browse-count");
  await expect(count).toHaveText(/^\d+ titles?$/);
  const before = parseInt((await count.textContent())!, 10);

  await page.goto("/#/preferences");
  await page.locator('select[data-max="violence"]').selectOption("0");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("concernLimits") ?? "{}"))).toEqual({
    max: { violence: 0 },
    hide: {},
  });

  // The Matrix is violent: its violence row is over the limit.
  await page.goto(`/#/r/${MATRIX}`);
  await expect(page.locator("#sec-ratings tr.over-limit", { hasText: "Violence" })).toBeVisible();

  // Browse leaves out the titles over the limit, and offers to show them.
  await page.goto("/#/browse");
  await expect(count).toHaveText(/^\d+ titles?$/);
  const after = parseInt((await count.textContent())!, 10);
  expect(after).toBeLessThan(before);
  const over = page.locator("#over-toggle");
  await expect(over).toBeVisible();
  await expect(over).toContainText(`Show ${before - after} title`);
  await over.locator("input").check();
  await expect(page).toHaveURL(/limits=off/);
  await expect(count).toHaveText(`${before} titles`);

  // Clear limits removes them.
  await page.goto("/#/preferences");
  await page.locator("#concerns").getByRole("button", { name: "Clear limits" }).click();
  await expect(page.locator('select[data-max="violence"]')).toHaveValue("");
  expect(errors).toEqual([]);
});

test("My services saves the services the user does not have", async ({ page, request }) => {
  const errors = await setUp(page);
  const watch = (await (await request.get(`/api/watch/${MATRIX}`)).json()) as { providers: { ids: number[] }[] };
  test.skip(!watch.providers.length, "The Matrix streams on no service just now.");

  await page.goto("/#/preferences");
  const services = page.locator("#services-body");
  await expect(services.locator(".service-list .pref").first()).toBeVisible();

  // Find narrows the list to matching services.
  await services.getByRole("searchbox", { name: "Find a service" }).fill("netflix");
  await expect(services.locator(".service-list .pref:visible")).not.toHaveCount(0);
  for (const name of await services.locator(".service-list .pref:visible").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.name))) {
    expect(name).toContain("netflix");
  }
  await services.getByRole("searchbox", { name: "Find a service" }).fill("");

  // Hide all: the title page shows no streaming services.
  await services.getByRole("button", { name: "Hide all" }).click();
  await expect(services.locator(".service-list input:checked")).toHaveCount(0);
  const hidden = await page.evaluate(() => JSON.parse(localStorage.getItem("hiddenProviders") ?? "[]") as number[]);
  for (const p of watch.providers) for (const id of p.ids) expect(hidden).toContain(id);
  await page.goto(`/#/r/${MATRIX}`);
  await ready(page);
  await expect(page.locator("#watch-slot")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#watch-slot")).toBeHidden();

  // Show all: they come back.
  await page.goto("/#/preferences");
  await page.locator("#services-body").getByRole("button", { name: "Show all" }).click();
  await expect(page.locator("#services-body .service-list input:not(:checked)")).toHaveCount(0);
  await page.goto(`/#/r/${MATRIX}`);
  await expect(page.locator("#watch-slot .watch-list li").first()).toBeVisible();
  expect(errors).toEqual([]);
});
