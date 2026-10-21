import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { IndexEntry } from "../src/shared/types.js";

// Shared setup for the browser tests. The tests use only titles that are
// already rated and 2 or more years old, so no page asks the AI for a rating
// (see src/server/refreshPolicy.ts).

/** Old rated movies with a mood. Used by many tests. */
export const MATRIX = "tmdb-movie-603";
export const DIE_HARD = "tmdb-movie-562";
/** A rated TV series (Ted Lasso). Season 1 is rated. */
export const TED_LASSO = "97546";

/** What a test puts in localStorage before the page loads. Values are stored as JSON. */
export type Storage = Partial<{
  watchlist: Record<string, { addedAt: string; kind: "movie" | "tv" | "book"; title: string; years: string | null; imageUrl: string | null }>;
  thumbs: Record<string, "up" | "down">;
  notInterested: Record<string, string>;
  hiddenProviders: number[];
  hiddenCategories: string[];
  concernLimits: { max: Record<string, number>; hide: Record<string, string[]> };
  /** null: the tip has not been seen. */
  concernsTipSeen: string | null;
}>;

/**
 * Give the page its saved choices, and collect its errors. The choices are
 * set once per tab, so a reload keeps what the page saved. The first-visit
 * tip is off unless the test sets its own storage for it.
 * Fails the test if the page asks for a mood rating (an AI call).
 */
export async function setUp(page: Page, storage: Storage = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    // Posters and logos come from TMDB and Open Library: a slow image is not a page error.
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) errors.push(msg.text());
  });
  page.on("request", (req) => {
    if (req.url().includes("/api/mood/")) errors.push(`Unexpected rating request: ${req.url()}`);
  });
  const values = { concernsTipSeen: "1", ...storage };
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("e2e-set")) return;
    sessionStorage.setItem("e2e-set", "1");
    for (const [key, value] of Object.entries(values)) {
      if (value === null) continue;
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }, values);
  return errors;
}

/** A watchlist entry for a rated title, as the page saves it. */
export function entry(t: IndexEntry, addedAt = new Date().toISOString()) {
  return { addedAt, kind: t.kind, title: t.title, years: t.years, imageUrl: t.imageUrl };
}

let titles: IndexEntry[] | null = null;

/** Every rated title, from the API. Loaded once per worker. */
export async function ratedTitles(request: APIRequestContext): Promise<IndexEntry[]> {
  if (!titles) {
    const res = await request.get("/api/titles");
    expect(res.ok()).toBe(true);
    titles = (await res.json()) as IndexEntry[];
  }
  return titles;
}

/** Wait until the page has drawn its view (the router removes the loading message). */
export async function ready(page: Page): Promise<void> {
  await expect(page.locator("#app h1").first()).toBeVisible();
}
