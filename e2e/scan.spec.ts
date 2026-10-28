import { expect, test } from "@playwright/test";
import { fakeCamera } from "./barcode.js";
import { ready, setUp } from "./helpers.js";

// The barcode scanner, with a fake camera that shows a book's ISBN barcode.
// Headless Chromium on Linux has no BarcodeDetector, so this uses the
// quagga2 reader. See scan-store.spec.ts for a store barcode.

test.use(fakeCamera("9780547928227"));

test("a scanned ISBN barcode searches for the ISBN", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Scan a book barcode" }).click();
  await expect(page.getByRole("dialog", { name: "Scan a book barcode" })).toBeVisible();
  await expect(page).toHaveURL(/\/search#q=9780547928227$/, { timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#search-input")).toHaveValue("9780547928227");
  await expect(page.locator("#search-results")).toContainText("The Hobbit", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
