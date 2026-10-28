// Page HTML for the app's paths, plus robots.txt and sitemap.xml. Every page
// is the same app (index.html); the app reads the path and draws the page.
// For a rated title, the HTML also has the title, a description, a canonical
// link, and the summary, so search engines can index it without running the
// app. Only saved results are read: a page request never starts an AI lookup
// or a catalog request, so crawlers cost almost nothing.

import { Hono, type Context } from "hono";
import { CATEGORIES, SCORE_MAX, type CategoryId } from "../shared/categories.js";
import { idPath, pathId, slug, titlePath } from "../shared/paths.js";
import type { IndexEntry, Report } from "../shared/types.js";
import type { ReportService } from "./reports.js";

const SITE_TITLE = "Parents' Guide";

/**
 * Crawlers that collect text to train AI models. The ratings are AI-generated,
 * so they are poor training data; these crawlers get nothing. Search engines,
 * and fetches that a person starts (ChatGPT-User, Claude-User), are not here.
 * Google-Extended and Applebot-Extended are not crawlers: they are the tokens
 * that keep Google's and Apple's crawled pages out of AI training.
 */
const AI_TRAINING_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "Meta-ExternalAgent",
  "FacebookBot",
  "Amazonbot",
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "ImagesiftBot",
  "Omgilibot",
  "Timpibot",
  "AI2Bot",
  "PanguBot",
];

/** Pages a search engine should not list: they are empty for a crawler, or depend on the visitor. */
const PRIVATE_PAGES = ["/search", "/watchlist", "/recommended", "/preferences"];

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The text up to about max characters, cut at a word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

interface PageMeta {
  title: string;
  description?: string;
  /** Path of the canonical page, e.g. /movie/603/the-matrix-1999. */
  canonical?: string;
  image?: string | null;
  noindex?: boolean;
  /** HTML for the app container, replaced when the app draws the page. */
  body?: string;
}

/** The app page with the meta tags and the body for one path. */
export function renderPage(shell: string, meta: PageMeta, origin: string): string {
  const head = [
    meta.description && `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    meta.canonical && `<link rel="canonical" href="${escapeHtml(origin + meta.canonical)}" />`,
    meta.canonical && `<meta property="og:url" content="${escapeHtml(origin + meta.canonical)}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    meta.description && `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    meta.image && `<meta property="og:image" content="${escapeHtml(meta.image)}" />`,
    meta.noindex && `<meta name="robots" content="noindex" />`,
  ]
    .filter(Boolean)
    .join("\n    ");
  let html = shell.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);
  if (meta.description) html = html.replace(/\n\s*<meta name="description"[^>]*>/, "");
  html = html.replace("</head>", `    ${head}\n  </head>`);
  if (meta.body) html = html.replace(/(<main id="app"[^>]*>)(<\/main>)/, `$1${meta.body}$2`);
  return html;
}

/** "Violence 4 of 5, Profanity and crude language 2 of 5": the scored categories, highest first. */
function scoreText(scores: Partial<Record<CategoryId, number>>): string[] {
  return CATEGORIES.filter((c) => scores[c.id] !== undefined)
    .sort((a, b) => scores[b.id]! - scores[a.id]!)
    .map((c) => `${c.label} ${scores[c.id]} of ${SCORE_MAX}`);
}

/** The page meta for a rated title, from its list entry and, for a movie, book, or season, its saved result. */
export function titleMeta(entry: IndexEntry | null, report: Report | null, path: string): PageMeta | null {
  if (!entry && !report) return null;
  // Books: the catalog subtitle ("The Graphic Novel"), else the byline in report.subtitle.
  const subtitle = report?.info?.subtitle ?? entry?.subtitle ?? report?.subtitle;
  const name = subtitle ? `${report?.title ?? entry!.title}: ${subtitle}` : (entry?.title ?? report!.title);
  const years = entry?.years ?? report?.releaseDate?.slice(0, 4) ?? null;
  const heading = years ? `${name} (${years})` : name;
  const scores =
    entry?.scores ??
    (Object.fromEntries(Object.entries(report!.categories).map(([id, r]) => [id, r.score])) as Partial<Record<CategoryId, number>>);
  const lines = scoreText(scores);
  const summary = report?.summary ?? "";
  const description = summary
    ? clip(summary, 155)
    : `What parents should know about ${heading}: ${lines.slice(0, 4).join(", ")}.`;
  const body = `<article class="prerender">
      <h1>${escapeHtml(heading)}</h1>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
      <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    </article>`;
  return {
    title: `${SITE_TITLE} - ${heading}`,
    description,
    canonical: path,
    image: entry?.imageUrl ?? null,
    body,
  };
}

/** Index entries by id, kept until the list changes. */
const byId = new WeakMap<readonly IndexEntry[], Map<string, IndexEntry>>();
function entryMap(titles: readonly IndexEntry[]): Map<string, IndexEntry> {
  let map = byId.get(titles);
  if (!map) byId.set(titles, (map = new Map(titles.map((t) => [t.id, t]))));
  return map;
}

/**
 * The page routes. shell: the built index.html. siteUrl: the public origin
 * (https://example.com) for the canonical links, the sitemap, and robots.txt;
 * without it, the request's host is used, and robots.txt has no sitemap line.
 */
export function createPages(reports: Pick<ReportService, "titles" | "savedReport">, shell: string, siteUrl = "") {
  const pages = new Hono();
  const origin = (url: string, proto?: string, host?: string) => {
    if (siteUrl) return siteUrl.replace(/\/+$/, "");
    const u = new URL(url);
    return `${proto ?? u.protocol.replace(":", "")}://${host ?? u.host}`;
  };
  const originOf = (c: Context) => origin(c.req.url, c.req.header("x-forwarded-proto"), c.req.header("host"));
  const page = (c: Context, meta: PageMeta) => {
    c.header("Cache-Control", "no-cache");
    return c.html(renderPage(shell, meta, originOf(c)));
  };

  pages.get("/robots.txt", (c) => {
    const lines = [
      ...AI_TRAINING_BOTS.map((bot) => `User-agent: ${bot}`),
      "Disallow: /",
      "",
      "User-agent: *",
      // Search engines run the app, so they need the API calls that draw a page.
      // A crawler never starts an AI lookup (see isCrawler in app.ts). Search sends
      // text to the catalogs, so it stays out.
      "Disallow: /api/search",
      ...PRIVATE_PAGES.map((p) => `Disallow: ${p}`),
    ];
    if (siteUrl) lines.push("", `Sitemap: ${origin("")}/sitemap.xml`);
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(`${lines.join("\n")}\n`);
  });

  pages.get("/sitemap.xml", async (c) => {
    const { titles } = await reports.titles();
    const base = originOf(c);
    const urls = ["/", ...titles.map(titlePath)].map((p) => `  <url><loc>${escapeHtml(base + p)}</loc></url>`);
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Content-Type", "application/xml; charset=utf-8");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  });

  const titlePage = async (c: Context, id: string) => {
    const { titles } = await reports.titles();
    const entry = entryMap(titles).get(id) ?? null;
    // A TV series has no saved result of its own: its seasons do.
    const report = id.startsWith("tmdb-tv-") && !/-s\d+$/.test(id) ? null : await reports.savedReport(id);
    // A season: the series title and the season's year.
    const seasonSlug = report && slug(report.title, report.releaseDate);
    const path = entry ? titlePath(entry) : `${idPath(id)}${seasonSlug ? `/${seasonSlug}` : ""}`;
    // Not rated yet: the app can rate it, but search engines should not list it.
    return page(c, titleMeta(entry, report, path) ?? { title: SITE_TITLE, noindex: true });
  };
  // /movie/603/<slug>, /book/OL82563W/<slug>, /tv/1399/<slug>, /tv/1399/season/1/<slug> (see src/shared/paths.ts).
  pages.get("*", async (c, next) => {
    const id = pathId(c.req.path);
    return id ? titlePage(c, id) : next();
  });

  pages.get("/browse", (c) => page(c, { title: `${SITE_TITLE} - Browse rated titles`, canonical: "/browse" }));
  for (const p of PRIVATE_PAGES) pages.get(p, (c) => page(c, { title: SITE_TITLE, noindex: true }));
  pages.get("/", (c) => page(c, { title: SITE_TITLE, canonical: "/" }));

  return pages;
}
