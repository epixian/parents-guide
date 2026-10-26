import { expect, test } from "@playwright/test";
import { ready, setUp } from "./helpers.js";

// The home page, the header, and the first-visit tip.

test("the home page shows the hero and the title rows", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Know what is in it before your kids see it." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.locator(".recent-row .cards > li").first()).toBeVisible();
  // No watchlist and no thumbs: no personal rows.
  await expect(page.locator(".watchlist")).toHaveCount(0);
  await expect(page.locator(".recommended")).toHaveCount(0);
  await expect(page.locator(".site-footer")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the header links open Browse, Watchlist, and Preferences", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  const header = page.locator("header");

  await header.getByRole("link", { name: "Browse" }).click();
  await expect(page).toHaveURL(/#\/browse$/);
  await expect(page.getByRole("heading", { name: "Browse rated titles" })).toBeVisible();

  await header.getByRole("link", { name: "Watchlist" }).click();
  await expect(page).toHaveURL(/#\/watchlist$/);
  await expect(page.getByRole("heading", { name: "My watchlist" })).toBeVisible();

  await header.getByRole("link", { name: "Preferences" }).click();
  await expect(page).toHaveURL(/#\/preferences$/);
  await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();

  // Back returns to the previous page.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "My watchlist" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the first-visit tip shows until the user dismisses it", async ({ page }) => {
  const errors = await setUp(page, { concernsTipSeen: null });
  await page.goto("/");
  const tip = page.locator("#concerns-tip");
  await expect(tip).toBeVisible();
  await tip.getByRole("button", { name: "Got it" }).click();
  await expect(tip).toBeHidden();
  await page.reload();
  await ready(page);
  await expect(tip).toBeHidden();
  expect(errors).toEqual([]);
});

test('"/" moves focus to the search box', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  await page.locator("body").press("/");
  await expect(page.locator("#search-input")).toBeFocused();
  expect(errors).toEqual([]);
});

test("the offline note shows while the browser is offline", async ({ page, context }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  const note = page.locator("#offline-note");
  await expect(note).toBeHidden();
  await context.setOffline(true);
  await expect(note).toBeVisible();
  await context.setOffline(false);
  await expect(note).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the logo is centered, and the installed app's back button is top left", async ({ page }) => {
    const errors = await setUp(page);
    // iOS marks the installed app with navigator.standalone.
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    await page.goto("/");
    await ready(page);
    const logo = (await page.locator(".brand").boundingBox())!;
    expect(Math.abs(logo.x + logo.width / 2 - 390 / 2)).toBeLessThanOrEqual(1);

    // The search box has its own row below the logo.
    const search = (await page.locator("#search-form").boundingBox())!;
    expect(search.y).toBeGreaterThanOrEqual(logo.y + logo.height);

    // First page: no earlier page, so the button keeps its place but is invisible.
    const back = page.locator("#back-button");
    await expect(back).toHaveClass(/away/);

    await page.locator("header").getByRole("link", { name: "Browse" }).click();
    await expect(page.getByRole("heading", { name: "Browse rated titles" })).toBeVisible();
    await expect(back).toBeVisible();
    const button = (await back.boundingBox())!;
    expect(button.x).toBeLessThan(logo.x);
    expect(button.x).toBeLessThanOrEqual(16);
    expect(Math.abs(button.y + button.height / 2 - (logo.y + logo.height / 2))).toBeLessThanOrEqual(2);
    // The logo does not move when the button shows.
    const after = (await page.locator(".brand").boundingBox())!;
    expect(after.x).toBeCloseTo(logo.x, 0);

    await back.click();
    await expect(page.getByRole("heading", { name: "Know what is in it before your kids see it." })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("the footer links to the Privacy and Terms page", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  await page.locator(".site-footer").getByRole("link", { name: "Privacy and Terms" }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
  await expect(page.getByRole("heading", { name: "Privacy and Terms", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Google Drive backup (optional)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Terms of Use" })).toBeVisible();
  expect(errors).toEqual([]);
});
