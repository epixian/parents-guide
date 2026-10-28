import { expect, test } from "@playwright/test";
import { fakeCamera } from "./barcode.js";
import { ready, setUp } from "./helpers.js";

// The barcode scanner, with a fake camera that shows a store barcode (UPC-A).

test.use(fakeCamera("036000291452"));

test("a store barcode says it is not the ISBN, and Cancel closes the scanner", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Scan a book barcode" }).click();
  const dialog = page.getByRole("dialog", { name: "Scan a book barcode" });
  await expect(dialog.getByRole("status")).toContainText("not the ISBN", { timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/:\d+\/$/);
  expect(errors).toEqual([]);
});
