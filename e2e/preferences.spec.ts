import { expect, test } from "@playwright/test";
import { MATRIX, pagePath, ready, setUp } from "./helpers.js";

// The Preferences page: topics, concern limits, and "My services".

test("a hidden topic leaves the title pages", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/preferences");
  await ready(page);
  const row = page.locator('#concerns .concern-row[data-topic="violence"]');
  await row.getByRole("checkbox", { name: "Violence" }).uncheck();
  await expect(row).toHaveClass(/is-hidden/);
  await expect(row.locator("select")).toBeDisabled();

  await page.goto(pagePath(MATRIX));
  await ready(page);
  const ratings = page.locator("#sec-ratings");
  await expect(ratings.getByRole("rowheader", { name: "Violence" })).toHaveCount(0);
  await expect(ratings).toContainText("1 topic(s) hidden by your preferences.");
  expect(errors).toEqual([]);
});

test("Hide all and Show all change every topic", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/preferences");
  await ready(page);
  const concerns = page.locator("#concerns");
  await concerns.getByRole("button", { name: "Hide all" }).click();
  await expect(concerns.locator("input[data-show]:checked")).toHaveCount(0);

  await page.goto(pagePath(MATRIX));
  await expect(page.getByText("All topics are hidden.")).toBeVisible();

  await page.goto("/preferences");
  await page.locator("#concerns").getByRole("button", { name: "Show all" }).click();
  await expect(page.locator("#concerns input[data-show]:not(:checked)")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a concern limit marks titles over it and filters Browse", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/browse");
  await ready(page);
  const count = page.locator("#browse-count");
  await expect(count).toHaveText(/^\d+ titles?$/);
  const before = parseInt((await count.textContent())!, 10);

  await page.goto("/preferences");
  await page.locator('select[data-max="violence"]').selectOption("0");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("concernLimits") ?? "{}"))).toEqual({
    max: { violence: 0 },
    hide: {},
  });

  // The Matrix is violent: its violence row is over the limit.
  await page.goto(pagePath(MATRIX));
  await expect(page.locator("#sec-ratings tr.over-limit", { hasText: "Violence" })).toBeVisible();

  // Browse leaves out the titles over the limit, and offers to show them.
  await page.goto("/browse");
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
  await page.goto("/preferences");
  await page.locator("#concerns").getByRole("button", { name: "Clear limits" }).click();
  await expect(page.locator('select[data-max="violence"]')).toHaveValue("");
  expect(errors).toEqual([]);
});

test("My services saves the services the user does not have", async ({ page, request }) => {
  const errors = await setUp(page);
  const watch = (await (await request.get(`/api/watch/${MATRIX}`)).json()) as { providers: { ids: number[] }[] };
  test.skip(!watch.providers.length, "The Matrix streams on no service just now.");

  await page.goto("/preferences");
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
  await page.goto(pagePath(MATRIX));
  await ready(page);
  await expect(page.locator("#watch-slot")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#watch-slot")).toBeHidden();

  // Show all: they come back.
  await page.goto("/preferences");
  await page.locator("#services-body").getByRole("button", { name: "Show all" }).click();
  await expect(page.locator("#services-body .service-list input:not(:checked)")).toHaveCount(0);
  await page.goto(pagePath(MATRIX));
  await expect(page.locator("#watch-slot .watch-list li").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the backup picker shows This device first, then connected services, then the others, by name", async ({ page }) => {
  const errors = await setUp(page);
  await page.goto("/preferences");
  await ready(page);
  const tabs = page.locator("#your-data").getByRole("tab");
  const names = () => tabs.locator(".backup-name").allTextContents();
  const services = (await names()).slice(1);
  expect((await names())[0]).toBe("This device");
  expect(services).toEqual([...services].sort((a, b) => a.localeCompare(b)));
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#backup-panel-local")).toBeVisible();

  // Arrow keys move between the tabs, and each tab shows only its own panel.
  test.skip(services.length === 0, "The build has no cloud service");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#backup-panel-local")).toBeHidden();
  await expect(page.locator("#your-data").getByRole("tabpanel")).toHaveCount(1);

  // A connected service moves to the front, after This device.
  const last = services.at(-1)!;
  const id = await page.locator("#your-data").getByRole("tab", { name: last }).getAttribute("data-backup-tab");
  await page.evaluate((id) => localStorage.setItem(`${id}Backup`, "1"), id);
  await page.reload();
  await ready(page);
  expect((await names()).slice(0, 2)).toEqual(["This device", last]);
  await expect(tabs.nth(1)).toHaveAccessibleName(`${last} (connected)`);
  expect(errors).toEqual([]);
});

/** A fake Web Share API that accepts every file and answers share() with the error, like Brave on a computer. */
async function fakeShare(page: import("@playwright/test").Page, error: string) {
  await page.addInitScript((error) => {
    navigator.canShare = () => true;
    navigator.share = () => Promise.reject(new DOMException("Permission denied", error));
  }, error);
}

test("Share backup does not show on a computer, even if the browser says it can share", async ({ page }) => {
  const errors = await setUp(page);
  await fakeShare(page, "NotAllowedError");
  await page.goto("/preferences");
  await ready(page);
  await expect(page.locator("#your-data").getByRole("button", { name: "Save to this device" })).toBeVisible();
  await expect(page.locator("#your-data").getByRole("button", { name: "Share backup…" })).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a share that the browser does not allow hides Share backup", async ({ page }) => {
    const errors = await setUp(page);
    await fakeShare(page, "NotAllowedError");
    await page.goto("/preferences");
    await ready(page);
    const share = page.locator("#your-data").getByRole("button", { name: "Share backup…" });
    await share.click();
    await expect(page.locator("#data-status")).toHaveText('This browser does not allow sharing. Use "Save to this device".');
    await expect(share).toBeHidden();
    await expect(page.locator("#your-data").getByRole("tab", { name: "This device" })).not.toContainText("Backed up");
    expect(errors).toEqual([]);
  });
});

test("Save to this device says Saved only after the save dialog wrote the file", async ({ page }) => {
  const errors = await setUp(page, { thumbs: { [MATRIX]: "up" } });
  // A fake save dialog: the test answers it, and the file lands in window.savedFile.
  await page.addInitScript(() => {
    const w = window as unknown as { answer: (name: string | null) => void; savedFile?: string };
    w.showSaveFilePicker = () =>
      new Promise((resolve, reject) => {
        w.answer = (name) =>
          name === null
            ? reject(new DOMException("The user aborted a request.", "AbortError"))
            : resolve({ name, createWritable: async () => ({ write: async (t: string) => void (w.savedFile = t), close: async () => {} }) });
      });
  });
  await page.goto("/preferences");
  await ready(page);
  const status = page.locator("#data-status");
  const save = page.locator("#your-data").getByRole("button", { name: "Save to this device" });

  // While the dialog is open, nothing is saved yet.
  const device = page.locator("#your-data").getByRole("tab", { name: "This device" });
  await save.click();
  await expect(status).toHaveText("");
  await expect(device).not.toContainText("Backed up");
  await page.evaluate(() => (window as unknown as { answer: (n: string | null) => void }).answer(null));
  await expect(status).toHaveText("");
  await expect(device).not.toContainText("Backed up");

  await save.click();
  await page.evaluate(() => (window as unknown as { answer: (n: string | null) => void }).answer("my-backup.json"));
  await expect(status).toHaveText("Saved my-backup.json.");
  await expect(page.locator("#your-data").getByRole("tab", { name: "This device" })).toContainText(/Backed up \w+ \d+/);
  const saved = await page.evaluate(() => (window as unknown as { savedFile?: string }).savedFile);
  expect(JSON.parse(saved!)).toMatchObject({ app: "parents-guide", data: { thumbs: `{"${MATRIX}":"up"}` } });
  expect(errors).toEqual([]);
});

test("Save to this device downloads a backup, and Restore from a file reads it back", async ({ page }) => {
  const errors = await setUp(page, { thumbs: { [MATRIX]: "up" }, hiddenCategories: ["violence"] });
  // As in Firefox, Safari, and Brave: no save dialog, so the browser downloads the file.
  await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  await page.goto("/preferences");
  await ready(page);
  const section = page.locator("#your-data");

  const download = page.waitForEvent("download");
  await section.getByRole("button", { name: "Save to this device" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^parents-guide-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const text = await (await file.createReadStream()).toArray().then((parts) => Buffer.concat(parts).toString());
  expect(JSON.parse(text)).toMatchObject({ app: "parents-guide", data: { thumbs: `{"${MATRIX}":"up"}` } });
  // The page cannot know when, or if, the download is saved: no message, and no date.
  await expect(page.locator("#data-status")).toHaveText("");
  await expect(section.getByRole("tab", { name: "This device" })).not.toContainText("Backed up");

  // Change the choices, then restore the file.
  await page.evaluate(() => {
    localStorage.removeItem("thumbs");
    localStorage.setItem("hiddenCategories", "[]");
  });
  page.once("dialog", (d) => void d.accept());
  const chooser = page.waitForEvent("filechooser");
  await section.getByRole("button", { name: "Restore from a file" }).click();
  const reloaded = page.waitForEvent("load");
  await (await chooser).setFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await reloaded;
  await ready(page);
  expect(await page.evaluate(() => localStorage.getItem("thumbs"))).toBe(`{"${MATRIX}":"up"}`);
  expect(await page.evaluate(() => localStorage.getItem("hiddenCategories"))).toBe('["violence"]');

  // A file that is not a backup changes nothing.
  const bad = page.waitForEvent("filechooser");
  await page.locator("#your-data").getByRole("button", { name: "Restore from a file" }).click();
  await (await bad).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.locator("#data-status")).toHaveText("The file is not a Parents' Guide backup.");
  expect(await page.evaluate(() => localStorage.getItem("thumbs"))).toBe(`{"${MATRIX}":"up"}`);
  expect(errors).toEqual([]);
});

test("Delete backup shows after a Drive connection, and asks in a dialog first", async ({ page }) => {
  const errors = await setUp(page);
  const google: string[] = [];
  page.on("request", (req) => {
    if (/google(apis)?\.com/.test(new URL(req.url()).hostname)) google.push(req.url());
  });
  await page.goto("/preferences");
  await ready(page);
  const backup = page.locator("#your-data");
  const tab = backup.getByRole("tab", { name: "Google Drive" });
  test.skip((await tab.count()) === 0, "The build has no GOOGLE_CLIENT_ID");
  await tab.click();
  const dialog = page.getByRole("dialog", { name: "Delete the backup?" });
  // Delete shows only after this browser used the Drive backup.
  await expect(backup.getByRole("button", { name: "Delete backup" })).toBeHidden();
  await page.evaluate(() => localStorage.setItem("driveBackup", "1"));
  await page.reload();
  await ready(page);
  await expect(tab).toHaveAccessibleName("Google Drive (connected)");
  await tab.click();

  await backup.getByRole("button", { name: "Delete backup" }).click();
  await expect(dialog).toBeVisible();
  // Cancel has the focus, so Enter does not delete.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await backup.getByRole("button", { name: "Delete backup" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await expect(page.locator("#data-status")).toHaveText("");
  expect(google).toEqual([]);
  expect(errors).toEqual([]);
});

test("Dropbox signs in in the same tab, then runs the backup, restore, and delete", async ({ page }) => {
  const errors = await setUp(page, { thumbs: { [MATRIX]: "up" } });
  await page.goto("/preferences");
  await ready(page);
  const section = page.locator("#your-data");
  const tab = section.getByRole("tab", { name: "Dropbox" });
  test.skip((await tab.count()) === 0, "The build has no DROPBOX_APP_KEY");
  await tab.click();

  // A fake Dropbox: sign-in sends the tab straight back, and the file lives in this test.
  let file: string | null = null;
  let signIns = 0;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  await page.route("https://www.dropbox.com/oauth2/authorize?**", (route) => {
    signIns++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const back = `${url.searchParams.get("redirect_uri")}?code=one-time&state=${url.searchParams.get("state")}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  });
  await page.route("https://api.dropboxapi.com/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/oauth2/token") return route.fulfill({ headers: cors, json: { access_token: "token", expires_in: 14400 } });
    if (path === "/2/files/delete_v2") {
      const had = file !== null;
      file = null;
      return had ? route.fulfill({ headers: cors, json: {} }) : route.fulfill({ status: 409, headers: cors, json: { error_summary: "path_lookup/not_found/" } });
    }
    return route.fulfill({ headers: cors, json: null }); // token/revoke
  });
  await page.route("https://content.dropboxapi.com/**", (route) => {
    if (route.request().url().endsWith("/upload")) {
      file = route.request().postData();
      return route.fulfill({ headers: cors, json: {} });
    }
    return file === null
      ? route.fulfill({ status: 409, headers: cors, json: { error_summary: "path/not_found/" } })
      : route.fulfill({ headers: cors, body: file });
  });

  // Back up: the tab goes to Dropbox, comes back to Preferences, and saves.
  await section.getByRole("button", { name: "Back up to Dropbox" }).click();
  // Back from the sign-in, the Dropbox tab is open again.
  await expect(page.locator("#data-status")).toContainText("Backed up to Dropbox");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toHaveAccessibleName(/^Dropbox Backed up \w+ \d+ \(connected\)$/);
  expect(page.url()).toMatch(/\/preferences$/);
  expect(JSON.parse(file!)).toMatchObject({ app: "parents-guide", data: { thumbs: `{"${MATRIX}":"up"}` } });
  const dropboxRow = page.locator('#your-data [data-service="dropbox"]');
  await expect(dropboxRow.getByRole("button", { name: "Delete backup" })).toBeVisible();

  // Restore: the token is still in memory, so no second sign-in.
  await page.evaluate(() => localStorage.removeItem("thumbs"));
  page.once("dialog", (d) => void d.accept());
  const reloaded = page.waitForEvent("load");
  await section.getByRole("button", { name: "Restore from Dropbox" }).click();
  await reloaded;
  await ready(page);
  expect(await page.evaluate(() => localStorage.getItem("thumbs"))).toBe(`{"${MATRIX}":"up"}`);
  expect(signIns).toBe(1);

  // Delete: the reload dropped the token, so it signs in again, then deletes.
  await tab.click();
  await dropboxRow.getByRole("button", { name: "Delete backup" }).click();
  await page.getByRole("dialog", { name: "Delete the backup?" }).getByRole("button", { name: "Delete backup" }).click();
  await expect(page.locator("#data-status")).toHaveText("Deleted the backup, and ended this site's access to your Dropbox.");
  expect(file).toBeNull();
  expect(signIns).toBe(2);
  await expect(dropboxRow.getByRole("button", { name: "Delete backup" })).toBeHidden();
  // Delete forgets the date too.
  await expect(tab).toHaveAccessibleName("Dropbox");
  expect(errors).toEqual([]);
});

test("Delete all data asks first, then empties this browser and opens the home page", async ({ page }) => {
  const errors = await setUp(page, { thumbs: { [MATRIX]: "up" }, hiddenCategories: ["violence"] });
  await page.goto("/preferences");
  await ready(page);
  const section = page.locator("#your-data");
  await expect(section.getByRole("heading", { name: "Your data" })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Delete all data?" });

  // Cancel keeps everything.
  await section.getByRole("button", { name: "Delete all data" }).click();
  // This browser never used the Drive backup: no choice to delete it.
  await expect(dialog.getByRole("checkbox", { name: "Also delete the backup in Google Drive" })).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("thumbs"))).not.toBeNull();

  // The saved title list is in IndexedDB once the page has loaded it.
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "parents-guide")))
    .toBe(true);

  await section.getByRole("button", { name: "Delete all data" }).click();
  // With the saved copy gone, the home page loads the whole list again, not only the changes.
  const wholeList = page.waitForRequest((req) => new URL(req.url()).pathname === "/api/titles");
  await dialog.getByRole("button", { name: "Delete all data" }).click();
  await expect(page.getByRole("heading", { name: "Know what is in it before your kids see it." })).toBeVisible();
  await wholeList;
  expect(await page.evaluate(() => [localStorage.getItem("thumbs"), localStorage.getItem("hiddenCategories")])).toEqual([null, null]);
  expect(errors).toEqual([]);
});
