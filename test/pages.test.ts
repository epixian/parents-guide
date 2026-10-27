import { test } from "node:test";
import assert from "node:assert/strict";
import { createPages } from "../src/server/pages.js";
import { idPath, pathId, slug, titlePath } from "../src/shared/paths.js";
import type { IndexEntry, Report } from "../src/shared/types.js";

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>Parents' Guide</title>
    <meta name="description" content="AI summaries of parental concerns for movies, TV shows, and books." />
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
  </body>
</html>`;

const MATRIX: IndexEntry = {
  id: "tmdb-movie-603",
  kind: "movie",
  title: "The Matrix",
  years: "1999",
  imageUrl: "https://image.tmdb.org/t/p/w342/matrix.jpg",
  addedAt: "2026-10-01T00:00:00Z",
  ratedParts: 1,
  themeTags: [],
  scores: { violence: 4, profanity: 2 },
  treatments: {},
};

const SERIES: IndexEntry = { ...MATRIX, id: "tmdb-tv-1399", kind: "tv", title: "Game of Thrones", years: "2011-2019" };

const REPORT = { id: "tmdb-movie-603", title: "The Matrix", subtitle: null, summary: "A hacker learns <the truth>." } as Report;

function pagesWith(saved: Report[] = [REPORT], siteUrl = "") {
  const calls: string[] = [];
  const reports = {
    titles: async () => ({ tag: "t", changeTag: "t", titles: [MATRIX, SERIES] }),
    savedReport: async (id: string) => {
      calls.push(id);
      return saved.find((r) => r.id === id) ?? null;
    },
  };
  return { pages: createPages(reports, SHELL, siteUrl), calls };
}

test("slug keeps a-z, 0-9, and dashes, with the first year", () => {
  assert.equal(slug("The Matrix", "1999"), "the-matrix-1999");
  assert.equal(slug("Amélie", null), "amelie");
  assert.equal(slug("Tom & Jerry's Show", "2011-2019"), "tom-and-jerrys-show-2011");
  assert.equal(slug(".hack//Sign", null), "hack-sign");
  assert.equal(slug("¿?", null), "");
  assert.ok(slug("word ".repeat(40), null).length <= 80);
});

test("titlePath and pathId convert between ids and paths of each kind", () => {
  assert.equal(titlePath(MATRIX), "/movie/603/the-matrix-1999");
  assert.equal(titlePath(SERIES), "/tv/1399/game-of-thrones-2011");
  assert.equal(titlePath({ id: "tmdb-tv-1399-s01", kind: "tv", title: "Game of Thrones", years: "2011" }), "/tv/1399/season/1/game-of-thrones-2011");
  assert.equal(titlePath({ id: "ol-OL1W", kind: "book", title: "!!", years: null }), "/book/OL1W");
  assert.equal(titlePath({ id: "bad", title: "x" }), "/");
  for (const id of ["tmdb-movie-603", "ol-OL1W", "tmdb-tv-1399", "tmdb-tv-1399-s01", "tmdb-tv-1399-s12"]) {
    assert.equal(pathId(idPath(id)!), id);
    assert.equal(pathId(`${idPath(id)}/any-slug`), id);
  }
  assert.equal(pathId("/tv/1399/season"), "tmdb-tv-1399"); // A series slug, not a season.
  for (const p of ["/movie/abc", "/movie/603/a/b", "/book/603", "/r/tmdb-movie-603", "/browse"]) assert.equal(pathId(p), null, p);
});

test("a rated title page has its title, description, canonical link, and summary", async () => {
  const { pages } = pagesWith();
  // Routing ignores the slug: a wrong one gets the same page, with the right canonical link.
  const res = await pages.request("https://example.com/movie/603/old-name");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Parents' Guide - The Matrix \(1999\)<\/title>/);
  assert.match(html, /<meta name="description" content="A hacker learns &lt;the truth&gt;\." \/>/);
  assert.equal(html.match(/name="description"/g)!.length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/movie\/603\/the-matrix-1999" \/>/);
  assert.match(html, /<main id="app" aria-live="polite"><article class="prerender">/);
  assert.match(html, /<li>Violence 4 of 5<\/li><li>Profanity and crude language 2 of 5<\/li>/);
  assert.doesNotMatch(html, /noindex/);

  // No slug works too.
  assert.match(await (await pages.request("https://example.com/movie/603")).text(), /The Matrix \(1999\)/);
});

test("a TV series page uses its list entry, and reads no saved result", async () => {
  const { pages, calls } = pagesWith();
  const html = await (await pages.request("https://example.com/tv/1399")).text();
  assert.match(html, /<title>Parents' Guide - Game of Thrones \(2011-2019\)<\/title>/);
  assert.match(html, /What parents should know about Game of Thrones/);
  assert.match(html, /href="https:\/\/example\.com\/tv\/1399\/game-of-thrones-2011"/);
  assert.deepEqual(calls, []);
});

test("a season page uses its saved result", async () => {
  const season = {
    ...REPORT,
    id: "tmdb-tv-1399-s01",
    title: "Game of Thrones",
    subtitle: "Season 1",
    releaseDate: "2011-04-17",
    categories: { violence: { score: 5, treatment: null, notes: "" } },
  } as unknown as Report;
  const { pages } = pagesWith([season]);
  const html = await (await pages.request("https://example.com/tv/1399/season/1")).text();
  assert.match(html, /<title>Parents' Guide - Game of Thrones: Season 1 \(2011\)<\/title>/);
  assert.match(html, /href="https:\/\/example\.com\/tv\/1399\/season\/1\/game-of-thrones-2011"/);
});

test("a title that is not rated gets the plain app page with noindex", async () => {
  const { pages } = pagesWith();
  const res = await pages.request("https://example.com/movie/1");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.match(html, /<main id="app" aria-live="polite"><\/main>/);
});

test("the private pages are noindex, and the canonical origin comes from the proxy headers", async () => {
  const { pages } = pagesWith();
  for (const p of ["/search", "/watchlist", "/recommended", "/preferences"]) {
    assert.match(await (await pages.request(`http://127.0.0.1:8787${p}`)).text(), /noindex/, p);
  }
  const res = await pages.request("http://127.0.0.1:8787/browse", {
    headers: { host: "pg.example.com", "x-forwarded-proto": "https" },
  });
  assert.match(await res.text(), /href="https:\/\/pg\.example\.com\/browse"/);
});

test("robots.txt has the Sitemap line only with SITE_URL", async () => {
  const without = await (await pagesWith().pages.request("http://x/robots.txt")).text();
  assert.match(without, /^User-agent: \*\nDisallow: \/api\/\n/);
  assert.match(without, /Disallow: \/search\n/);
  assert.doesNotMatch(without, /Sitemap/);
  const withUrl = await (await pagesWith([], "https://example.com/").pages.request("http://x/robots.txt")).text();
  assert.match(withUrl, /\nSitemap: https:\/\/example\.com\/sitemap\.xml\n$/);
});

test("sitemap.xml lists the home page and every rated title", async () => {
  const { pages, calls } = pagesWith([], "https://example.com");
  const res = await pages.request("http://127.0.0.1/sitemap.xml");
  assert.match(res.headers.get("content-type")!, /application\/xml/);
  const xml = await res.text();
  assert.deepEqual(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    ["https://example.com/", "https://example.com/movie/603/the-matrix-1999", "https://example.com/tv/1399/game-of-thrones-2011"],
  );
  assert.deepEqual(calls, []);
});
