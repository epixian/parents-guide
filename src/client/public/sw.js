// Service worker: offline use, in the installed app and in browser tabs.
// Registered by main.ts in production builds only.
//
// - App pages (/, /movie/..., /tv/..., /browse, ...): network first, so a deploy reaches
//   every visitor who is online. With no answer in 3 seconds, or no network,
//   the saved copy of "/". The app reads the path, so that copy draws any
//   page. Only "/" is saved: a title page's HTML has that title's meta tags.
// - App files (/assets/*, fonts, icons, logos): from the cache first. Vite puts
//   a content hash in each /assets/ name, so a saved file never goes stale.
//   Files that neither the current nor the previous page uses are deleted.
// - API answers for pages seen before (titles, seasons, moods, streaming,
//   similar titles, home page lists, the catalog list): network first, the
//   saved answer offline. At most DATA_MAX answers; the oldest go first.
// - Not cached: the title list (titles.ts keeps it in IndexedDB), searches,
//   and posters from TMDB (other-origin images use a lot of the storage quota).
//
// This file has no content hash, so the server sends it with "no-cache", and
// the browser checks it for changes on each visit. Change CACHE_VERSION when
// the cache layout changes: activate then deletes the old caches.

const CACHE_VERSION = 1;
const SHELL = `shell-v${CACHE_VERSION}`;
const DATA = `data-v${CACHE_VERSION}`;
const DATA_MAX = 300;
const PAGE_TIMEOUT_MS = 3000;
/** Files that are not in index.html, saved at install. */
const STATIC = ["/favicon.svg", "/manifest.webmanifest", "/fonts/fredoka-600-logo.woff2", "/icons/icon-192.png"];
const APP_FILE = /^\/(assets|fonts|icons|logos)\/|^\/(favicon\.svg|manifest\.webmanifest)$/;
/** The app's pages: as APP_PAGE in main.ts, plus the title pages of src/shared/paths.ts. Not privacy.html. */
const APP_PAGE =
  /^\/(?:(?:browse|watchlist|recommended|preferences|search)?|movie\/\d+(?:\/[^/]*)?|book\/OL\d+W(?:\/[^/]*)?|tv\/\d+(?:\/season\/\d+)?(?:\/[^/]*)?)$/;
const API_SAVED = /^\/api\/(report|tv|mood|watch|similar|recent|trending|catalog|providers)(\/|$)/;

/** The /assets/ files that a page uses. */
const assetsIn = (html) => [...new Set(html.match(/\/assets\/[\w.-]+/g) ?? [])];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const res = await fetch("/", { cache: "no-cache" });
      if (!res.ok) throw new Error(`Page answered ${res.status}`);
      const html = await res.clone().text();
      await cache.put("/", res);
      await cache.addAll([...assetsIn(html), ...STATIC]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL && key !== DATA) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Only app pages: other pages (privacy.html) must not replace the saved copy of "/".
  if (req.mode === "navigate" && APP_PAGE.test(url.pathname)) event.respondWith(page(event, url.pathname));
  else if (APP_FILE.test(url.pathname)) event.respondWith(cacheFirst(req));
  else if (API_SAVED.test(url.pathname)) event.respondWith(networkFirst(req));
});

/** Save a new page, and delete the app files that neither it nor the page before it uses. */
async function savePage(cache, res) {
  const old = await cache.match("/");
  const keep = new Set(assetsIn(await res.clone().text()));
  if (old) for (const a of assetsIn(await old.text())) keep.add(a);
  await cache.put("/", res);
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path.startsWith("/assets/") && !keep.has(path)) await cache.delete(key);
  }
}

/**
 * After a page other than "/" loads, save a new copy of "/" when the page uses
 * other app files than the saved copy (after a deploy).
 */
async function refreshShell(cache, res) {
  const saved = await cache.match("/");
  const now = assetsIn(await res.text()).sort().join(" ");
  if (saved && assetsIn(await saved.text()).sort().join(" ") === now) return;
  const shell = await fetch("/", { cache: "no-cache" });
  if (shell.ok) await savePage(cache, shell);
}

async function page(event, path) {
  const cache = await caches.open(SHELL);
  const network = fetch(event.request).then(async (res) => {
    // In the background: a failed save must not lose the page. network is still open, so the worker stays alive.
    if (res.ok) event.waitUntil((path === "/" ? savePage(cache, res.clone()) : refreshShell(cache, res.clone())).catch(() => {}));
    return res;
  });
  // Keep saving a page that arrives after the timeout.
  event.waitUntil(network.catch(() => {}));
  const saved = await cache.match("/");
  if (!saved) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(saved), PAGE_TIMEOUT_MS));
  return Promise.race([network.catch(() => saved), timeout]);
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.ok) {
      // put moves an entry to the end, so the oldest answers come first in keys().
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - DATA_MAX))) await cache.delete(key);
    }
    return res;
  } catch {
    const saved = await cache.match(req);
    if (saved) return saved;
    return new Response(JSON.stringify({ error: "You are offline, and this page was not saved." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
