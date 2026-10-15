import "./style.css";
import {
  CATEGORIES,
  CATEGORY_SECTIONS,
  COMPOSITES,
  SCORE_LABELS,
  SCORE_MAX,
  TREATMENTS,
  type Category,
  type CategoryId,
  type TreatmentId,
} from "../shared/categories.js";
import { THEME_TAGS } from "../shared/themes.js";
import type {
  AudienceScore,
  BrowseResponse,
  CategoryRange,
  CreditEntry,
  IndexEntry,
  RecentItem,
  RecentResponse,
  Report,
  SearchResult,
  SeriesResponse,
  WorkInfo,
} from "../shared/types.js";
import { api } from "./api.js";
import { loadHidden, markTipSeen, saveHidden, tipSeen, visibleCategories } from "./prefs.js";

const app = document.querySelector<HTMLElement>("#app")!;
const searchForm = document.querySelector<HTMLFormElement>("#search-form")!;
const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;
const prefsBody = document.querySelector<HTMLElement>("#prefs-body")!;

let hidden = loadHidden();

const esc = (s: string | number | null | undefined): string =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const KIND_LABEL: Record<SearchResult["kind"], string> = { movie: "Movie", tv: "TV series", book: "Book" };

// ---------- Preferences ----------

function renderPrefs(): void {
  prefsBody.innerHTML = `
    <p class="muted">Uncheck the topics you do not want to see.</p>
    <p class="pref-actions">
      <button type="button" data-all="show">Show all</button>
      <button type="button" data-all="hide">Hide all</button>
    </p>
    ${CATEGORY_SECTIONS.map(
      (section) => `
      <fieldset class="pref-section">
        <legend>${esc(section.label)}</legend>
        ${CATEGORIES.filter((c) => c.section === section.id)
          .map(
            (c) => `
        <label class="pref">
          <input type="checkbox" value="${c.id}" ${hidden.has(c.id) ? "" : "checked"} />
          <span>${esc(c.label)}</span>
        </label>`,
          )
          .join("")}
      </fieldset>`,
    ).join("")}`;
}

/**
 * Table rows for the visible categories, with a heading row before each
 * section. A section with no rows gets no heading.
 */
function sectionRows(row: (c: Category) => string, columns: number): string {
  const visible = visibleCategories(hidden);
  return CATEGORY_SECTIONS.map((section) => {
    const rows = visible
      .filter((c) => c.section === section.id)
      .map(row)
      .filter(Boolean)
      .join("");
    return rows ? `<tr class="section-row"><th colspan="${columns}" scope="colgroup">${esc(section.label)}</th></tr>${rows}` : "";
  }).join("");
}

prefsBody.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  const id = box.value as CategoryId;
  if (box.checked) hidden.delete(id);
  else hidden.add(id);
  saveHidden(hidden);
  void route(); // Re-render the current view with the new filter.
});

prefsBody.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-all]")?.dataset.all;
  if (!action) return;
  hidden = action === "hide" ? new Set(CATEGORIES.map((c) => c.id)) : new Set();
  saveHidden(hidden);
  renderPrefs();
  void route();
});

// First-visit tip next to "My concerns". Opening the panel also counts as seen.
const tip = document.querySelector<HTMLElement>("#concerns-tip")!;
const prefsDetails = document.querySelector<HTMLDetailsElement>("#prefs")!;

function dismissTip(): void {
  if (tip.hidden) return;
  tip.hidden = true;
  markTipSeen();
}

tip.hidden = tipSeen();
document.querySelector("#concerns-tip-close")!.addEventListener("click", dismissTip);
prefsDetails.addEventListener("toggle", () => {
  if (prefsDetails.open) dismissTip();
});

// ---------- Rendering helpers ----------

function scoreBar(score: number): string {
  const pct = Math.round((score / SCORE_MAX) * 100);
  return `<span class="bar" data-level="${score}" role="img" aria-label="${score} of ${SCORE_MAX}: ${esc(SCORE_LABELS[score])}"><span style="width:${pct}%"></span></span>`;
}

function rangeBar(range: CategoryRange): string {
  const left = Math.round((range.min / SCORE_MAX) * 100);
  const width = Math.max(4, Math.round(((range.max - range.min) / SCORE_MAX) * 100));
  return `<span class="bar range" data-level="${range.max}" role="img" aria-label="${range.min} to ${range.max} of ${SCORE_MAX}"><span style="left:${left}%;width:${width}%"></span></span>`;
}

const TREATMENT_BY_ID = new Map(TREATMENTS.map((t) => [t.id, t]));

/** How the work presents the content. Nothing for "not present" or categories without a treatment. */
function treatmentChip(id: TreatmentId | null | undefined): string {
  const t = id && id !== "not_present" ? TREATMENT_BY_ID.get(id) : undefined;
  if (!t) return "";
  return `<span class="treatment" data-treatment="${t.id}" title="${esc(t.description)}">${esc(t.label)}</span>`;
}

/** A credited name, linked to its catalog page when the URL is known. */
function creditHtml(e: CreditEntry): string {
  return e.url && /^https:\/\//.test(e.url)
    ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>`
    : esc(e.name);
}

/** "27k" for 27,123; small counts as they are. */
const compactCount = (n: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(n);

/**
 * Percent ring in the style TMDB uses for its user score: green from 70%,
 * yellow from 40%, red below.
 */
function scoreRing(percent: number): string {
  const tone = percent >= 70 ? "high" : percent >= 40 ? "mid" : "low";
  return `
    <svg class="score-ring" data-tone="${tone}" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="18" class="ring-bg" />
      <circle cx="18" cy="18" r="14.5" class="ring-track" />
      <circle cx="18" cy="18" r="14.5" class="ring-fill" pathLength="100" stroke-dasharray="${percent} 100" transform="rotate(-90 18 18)" />
      <text x="18" y="18" class="ring-text">${percent}<tspan class="ring-pct" dy="-3">%</tspan></text>
    </svg>`;
}

/**
 * Audience score from the catalog. TMDB: a percent ring ("87%" for 8.7/10).
 * Others: "★ 4.2/5". The full vote count is in the tooltip.
 */
function audienceHtml(a: AudienceScore | null | undefined, sourceUrl: string | undefined): string {
  if (!a) return "";
  const tip = `Average user score on ${a.source}: ${a.average.toFixed(1)} of ${a.scale}, from ${a.count.toLocaleString("en")} votes`;
  const score =
    a.scale === 10 ? scoreRing(Math.round(a.average * 10)) : esc(`★ ${a.average.toFixed(1)}/${a.scale}`);
  const inner = `${score} <span class="muted small">${esc(a.source)} · ${esc(compactCount(a.count))} votes</span>`;
  return sourceUrl && /^https:\/\//.test(sourceUrl)
    ? `<a class="audience" href="${esc(sourceUrl)}" target="_blank" rel="noopener" title="${esc(tip)}">${inner}</a>`
    : `<span class="audience" title="${esc(tip)}">${inner}</span>`;
}

/** Title area: poster, title, year, rating, and the composites. Details go lower on the page. */
function titleHeader(title: string, subtitle: string | null, info: WorkInfo | undefined, composites: string): string {
  const facts = [
    info?.years ? `<span>${esc(info.years)}</span>` : "",
    info?.rating
      ? `<span class="rating" title="${esc(info.rating.system)} rating">${esc(info.rating.value)}</span>`
      : "",
    audienceHtml(info?.audience, info?.source?.url),
  ].filter(Boolean);
  // Books: the authors, linked like the other credits. They also stay in the details box.
  const authors = info?.credits.find((c) => c.label === "Author")?.entries ?? [];
  const byline = authors.map(creditHtml).join(", ");
  return `
    <section class="title-area${info?.imageUrl ? " has-poster" : ""}">
      ${info?.imageUrl ? `<img class="poster" src="${esc(info.imageUrl)}" alt="" />` : ""}
      <div class="title-text">
        <h1>${esc(title)}${subtitle ? ` <span class="muted">— ${esc(subtitle)}</span>` : ""}</h1>
        ${byline ? `<p class="byline">by ${byline}</p>` : ""}
        ${facts.length ? `<p class="facts">${facts.join("")}</p>` : ""}
      </div>
      ${composites}
    </section>`;
}

/** Average and highest of the given scores, or null if there are none. */
function summarize(scores: (number | undefined)[]): { avg: number; max: number } | null {
  const known = scores.filter((n): n is number => typeof n === "number");
  if (!known.length) return null;
  return { avg: known.reduce((a, b) => a + b, 0) / known.length, max: Math.max(...known) };
}

const pct = (score: number) => `${Math.round((score / SCORE_MAX) * 100)}%`;

/**
 * One composite: the average, with the highest single score as a faded layer
 * behind it on the same bar. An average alone can hide one strong topic.
 */
function compositeTile(label: string, { avg, max }: { avg: number; max: number }): string {
  const level = Math.round(avg);
  const showMax = max > avg;
  return `
    <div class="composite" aria-label="${esc(label)}: average ${avg.toFixed(1)}, highest ${max} of ${SCORE_MAX}">
      <span class="composite-label">${esc(label)}</span>
      <span class="composite-value"><strong>${avg.toFixed(1)}</strong> / ${SCORE_MAX}</span>
      <span class="bar layered" aria-hidden="true">
        ${showMax ? `<span class="bar-max" data-level="${max}" style="width:${pct(max)}"></span>` : ""}
        <span class="bar-avg" data-level="${level}" style="width:${pct(avg)}"></span>
      </span>
      <span class="composite-label">${esc(SCORE_LABELS[level])}${showMax ? ` · highest ${max}` : ""}</span>
    </div>`;
}

/**
 * Group composites: the average score of the group's topics that the user has
 * not hidden. A group with every topic hidden is left out. For a series, pass
 * the highest score of each topic; the labels then say "up to".
 */
function compositesHtml(scoreOf: (id: CategoryId) => number | undefined, opts: { upTo?: boolean } = {}): string {
  const visible = new Set(visibleCategories(hidden).map((c) => c.id));
  const tiles = COMPOSITES.flatMap((group) => {
    const result = summarize(group.categories.filter((id) => visible.has(id)).map(scoreOf));
    return result ? [compositeTile(`${opts.upTo ? "Up to · " : ""}${group.label}`, result)] : [];
  });
  return tiles.length ? `<div class="composites">${tiles.join("")}</div>` : "";
}

/**
 * Jump links to the sections below. Buttons, not #anchors: the page uses the
 * URL hash for routing.
 */
function jumpLinks(sections: [id: string, label: string][]): string {
  return `<nav class="jumps" aria-label="On this page">${sections
    .map(([id, label]) => `<button type="button" data-jump="${id}">${esc(label)}</button>`)
    .join("")}</nav>`;
}

/** Details box: credits, themes, and the catalog link. */
function detailsBox(info: WorkInfo | undefined, themes: string[] = []): string {
  // Values are HTML: credits may contain links.
  const rows: [label: string, html: string][] = [
    ...(info?.credits ?? []).map((c): [string, string] => [c.label, (c.entries ?? []).map(creditHtml).join(", ")]),
    ...(themes.length ? [["Themes", esc(themes.join(" · "))] as [string, string]] : []),
  ];
  return `
    <section class="card section" id="sec-details">
      <h2>Details</h2>
      <div class="info">
        <div class="info-text">
          ${
            rows.length
              ? `<dl>${rows.map(([label, html]) => `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`).join("")}</dl>`
              : `<p class="muted">No details available.</p>`
          }
          ${info?.source ? `<p class="source"><a href="${esc(info.source.url)}" target="_blank" rel="noopener">View on ${esc(info.source.name)}</a></p>` : ""}
        </div>
      </div>
    </section>`;
}

function setLoading(message: string): void {
  app.innerHTML = `<p class="status"><span class="spinner" aria-hidden="true"></span>${esc(message)}</p>`;
}

function errorHtml(err: unknown): string {
  return `<p class="status error">${esc((err as Error).message)}</p>`;
}

function hiddenNote(): string {
  const hiddenCount = CATEGORIES.length - visibleCategories(hidden).length;
  return hiddenCount ? `<p class="muted small">${hiddenCount} topic(s) hidden by your preferences.</p>` : "";
}

function ratingsSection(report: Report): string {
  const rows = sectionRows((c) => {
    const r = report.categories[c.id];
    if (!r) return "";
    return `
      <tr>
        <th scope="row">${esc(c.label)}</th>
        <td class="score">${scoreBar(r.score)}<span class="score-label">${r.score} · ${esc(SCORE_LABELS[r.score])}</span>${treatmentChip(r.treatment)}</td>
        <td>${esc(r.notes)}</td>
      </tr>`;
  }, 3);
  return `
    <section class="card section" id="sec-ratings">
      <h2>Ratings</h2>
      <table class="ratings">
        <thead><tr><th>Topic</th><th>Level</th><th>Details</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="muted">All topics are hidden. Change "My concerns" to see them.</td></tr>`}</tbody>
      </table>
      ${hiddenNote()}
    </section>`;
}

function summarySection(report: Report): string {
  const positives = report.positives ?? [];
  return `
    <section class="card section" id="sec-summary">
      <h2>Summary</h2>
      <p class="summary">${esc(report.summary)}</p>
      ${
        positives.length
          ? `<div class="positives"><h3>Positive elements</h3><ul>${positives.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
          : ""
      }
    </section>`;
}

// ---------- Views ----------

const SEARCH_KINDS: { kind: SearchResult["kind"]; label: string }[] = [
  { kind: "movie", label: "Movies" },
  { kind: "tv", label: "TV shows" },
  { kind: "book", label: "Books" },
];

type SearchFilter = SearchResult["kind"] | "all";
const SEARCH_FILTER_KEY = "pairents.searchFilter";

function loadSearchFilter(): SearchFilter {
  try {
    const v = localStorage.getItem(SEARCH_FILTER_KEY);
    return v === "movie" || v === "tv" || v === "book" ? v : "all";
  } catch {
    return "all";
  }
}

function saveSearchFilter(f: SearchFilter): void {
  try {
    localStorage.setItem(SEARCH_FILTER_KEY, f);
  } catch {
    // Storage blocked: the filter lasts for this page view only.
  }
}

function resultItem(r: SearchResult, rated = false): string {
  return `
    <li>
      <a href="${r.kind === "tv" ? `#/tv/${r.id.replace("tmdb-tv-", "")}` : `#/r/${r.id}`}">
        ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" alt="" loading="lazy" />` : `<span class="noimg" aria-hidden="true"></span>`}
        <span class="result-text">
          <strong>${esc(r.title)}</strong> ${r.year ? `<span class="muted">(${r.year})</span>` : ""}
          <span class="badge">${KIND_LABEL[r.kind]}</span>
          ${rated ? `<span class="badge rated">Rated</span>` : ""}
          ${r.released === false ? `<span class="badge upcoming">Not yet released</span>` : ""}
          ${r.detail ? `<span class="muted small block">${esc(r.detail)}</span>` : ""}
        </span>
      </a>
    </li>`;
}

/** Show only the selected type's group (or all groups), and mark the pressed filter button. */
function applySearchFilter(filter: SearchFilter): void {
  for (const group of app.querySelectorAll<HTMLElement>(".result-group")) {
    group.hidden = filter !== "all" && group.dataset.kind !== filter;
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>("button[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  }
}

/** Catalog search results (TMDB and Open Library), grouped by type, with the type filter. */
function catalogHtml({ results, warnings }: { results: SearchResult[]; warnings: string[] }, rated: Set<string>): string {
  const groups = SEARCH_KINDS.map((k) => ({ ...k, items: results.filter((r) => r.kind === k.kind) })).filter(
    (g) => g.items.length,
  );
  // A remembered filter for a type with no results falls back to "All".
  const saved = loadSearchFilter();
  const filter: SearchFilter = groups.some((g) => g.kind === saved) ? saved : "all";

  const filterButton = (value: SearchFilter, label: string, count: number) =>
    `<button type="button" data-filter="${value}" aria-pressed="${value === filter}">${esc(label)} <span class="count">${count}</span></button>`;

  return `
    ${warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join("")}
    ${
      groups.length
        ? `<nav class="filters" aria-label="Filter results">
            ${filterButton("all", "All", results.length)}
            ${groups.map((g) => filterButton(g.kind, g.label, g.items.length)).join("")}
          </nav>
          ${groups
            .map(
              (g) => `
            <section class="result-group" data-kind="${g.kind}"${filter !== "all" && filter !== g.kind ? " hidden" : ""}>
              <h2>${esc(g.label)}</h2>
              <ul class="results">${g.items.map((r) => resultItem(r, rated.has(r.id))).join("")}</ul>
            </section>`,
            )
            .join("")}`
        : `<p class="status">No matches. Try another spelling.</p>`
    }`;
}

/** Rated titles shown at the top of the search results. */
const RATED_SHOWN = 12;

/**
 * Search: titles that are already rated show at once (from the server's index),
 * and the slower catalog search fills in below, behind a spinner.
 */
async function showSearch(q: string): Promise<string> {
  searchInput.value = q;
  setLoading(`Searching for "${q}"…`);
  const catalog = api.search(q);
  catalog.catch(() => {}); // Handled in afterRender; avoids an unhandled rejection meanwhile.
  // Ask for more than are shown, to mark rated titles in the catalog results.
  const rated = await api.browse(new URLSearchParams({ q, limit: "60" }).toString()).catch(() => null);
  const ratedIds = new Set(rated?.items.map((t) => t.id) ?? []);

  const seq = navSeq;
  afterRender = () => {
    void catalog
      .then((res) => catalogHtml(res, ratedIds))
      .catch((err: unknown) => errorHtml(err))
      .then((html) => {
        const box = document.querySelector<HTMLElement>("#search-catalog");
        if (seq !== navSeq || !box) return;
        box.innerHTML = html;
        box.removeAttribute("aria-busy");
      });
  };

  const ratedHtml = rated?.total
    ? `<section class="recent rated-matches">
        <h2>Already rated</h2>
        <ul class="cards">${rated.items.slice(0, RATED_SHOWN).map((t) => cardHtml(t, true, miniComposites(t))).join("")}</ul>
        ${rated.total > RATED_SHOWN ? `<p><a href="#/browse?${new URLSearchParams({ q })}">See all ${rated.total} rated matches →</a></p>` : ""}
      </section>`
    : "";

  return `
    <h1>Results for "${esc(q)}"</h1>
    ${ratedHtml}
    <div id="search-catalog" aria-busy="true">
      <p class="status"><span class="spinner" aria-hidden="true"></span>Searching movies, TV shows, and books…</p>
    </div>`;
}

async function showReport(id: string): Promise<string> {
  setLoading("Getting the rating. A new title can take up to a minute…");
  const res = await api.report(id);
  const seriesMatch = /^tmdb-tv-(\d+)-s\d+$/.exec(id);
  const back = seriesMatch ? `<p><a href="#/tv/${seriesMatch[1]}">← All seasons</a></p>` : "";
  if (res.status === "unreleased") {
    return `${back}<h1>${esc(res.title)}</h1>
      <p class="status">Not yet released${res.releaseDate ? ` (expected ${esc(res.releaseDate)})` : ""}. Ratings are available after release.</p>`;
  }
  const r = res.report;
  pageMeta = `Rated ${new Date(r.refreshedAt).toLocaleDateString()} by ${r.model} · confidence: ${r.confidence}`;
  return `${back}
    ${titleHeader(r.title, r.kind === "tv-season" ? r.subtitle : null, r.info, compositesHtml((id) => r.categories[id]?.score))}
    ${r.confidence === "low" ? `<p class="notice">The AI knows this work only a little. Details can be wrong.</p>` : ""}
    ${res.stale ? `<p class="notice">This result could not be refreshed just now. It may be out of date.</p>` : ""}
    ${jumpLinks([
      ["sec-ratings", "Ratings"],
      ["sec-summary", "Summary"],
      ["sec-details", "Details"],
    ])}
    ${ratingsSection(r)}
    ${summarySection(r)}
    ${detailsBox(r.info, r.themes)}`;
}

/** Themes across the rated seasons, most frequent first. */
function seriesThemes(s: SeriesResponse): string[] {
  const counts = new Map<string, number>();
  for (const season of s.seasons) {
    for (const t of season.report?.themes ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
}

async function showSeries(tmdbId: string): Promise<string> {
  setLoading("Loading series…");
  const s: SeriesResponse = await api.series(tmdbId);
  const agg = s.aggregate;
  const aggRows = sectionRows((c) => {
    const range = agg.categories[c.id];
    if (!range) return "";
    const text = range.min === range.max ? `${range.max}` : `${range.min}–${range.max}`;
    return `<tr><th scope="row">${esc(c.label)}</th><td class="score">${rangeBar(range)}<span class="score-label">${text}</span></td></tr>`;
  }, 2);

  const seasonsList = s.seasons
    .map(
      (season) => `
        <li>
          <span><strong>${esc(season.name)}</strong> <span class="muted small">${season.episodeCount} episodes${season.airDate ? ` · ${esc(season.airDate.slice(0, 4))}` : ""}</span></span>
          ${
            season.report
              ? `<a class="button" href="#/r/${season.reportId}">View rating</a>`
              : season.released
                ? `<a class="button primary" href="#/r/${season.reportId}">Rate this season</a>`
                : `<span class="muted small">Not yet released</span>`
          }
        </li>`,
    )
    .join("");

  const sections: [string, string][] = [
    ["sec-ratings", "Ratings"],
    ["sec-seasons", "Seasons"],
    ...(s.overview ? ([["sec-summary", "Summary"]] as [string, string][]) : []),
    ["sec-details", "Details"],
  ];

  return `
    ${titleHeader(s.title, null, s.info, compositesHtml((id) => agg.categories[id]?.max, { upTo: true }))}
    ${jumpLinks(sections)}
    <section class="card section" id="sec-ratings">
      <h2>Ratings for the whole series</h2>
      ${
        agg.ratedSeasons
          ? `${agg.partial ? `<p class="notice">Partial: based on ${agg.ratedSeasons} of ${agg.releasedSeasons} released seasons. Rate more seasons below to complete it.</p>` : ""}
             <table class="ratings"><tbody>${aggRows}</tbody></table>
             ${hiddenNote()}`
          : `<p class="muted">No seasons rated yet. Select a season below.</p>`
      }
    </section>
    <section class="card section" id="sec-seasons">
      <h2>Seasons</h2>
      <ul class="seasons">${seasonsList}</ul>
    </section>
    ${s.overview ? `<section class="card section" id="sec-summary"><h2>Summary</h2><p class="summary">${esc(s.overview)}</p></section>` : ""}
    ${detailsBox(s.info, seriesThemes(s))}`;
}

const RECENT_HEADINGS: Record<RecentItem["kind"], string> = { movie: "Movies", tv: "TV shows", book: "Books" };

function recentHref(item: RecentItem): string {
  return item.kind === "tv" ? `#/tv/${item.id.replace("tmdb-tv-", "")}` : `#/r/${item.id}`;
}

/** extra: HTML between the poster and the title (the composite bars). */
function cardHtml(item: RecentItem, showKind: boolean, extra = ""): string {
  return `
    <li>
      <a href="${recentHref(item)}">
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" loading="lazy" />` : `<span class="noimg" aria-hidden="true"></span>`}
        ${extra}
        <span class="card-title">${esc(item.title)}</span>
        <span class="muted small">${[showKind ? KIND_LABEL[item.kind] : "", item.years ?? ""].filter(Boolean).map(esc).join(" · ")}</span>
      </a>
    </li>`;
}

/** Most viewed titles of the last week, all types in one row. Empty when nothing trends yet. */
function trendingHtml(items: RecentItem[]): string {
  if (!items.length) return "";
  return `
    <section class="recent trending">
      <h2>Trending this week</h2>
      <ul class="cards">${items.map((item) => cardHtml(item, true, miniComposites(item))).join("")}</ul>
    </section>`;
}

/** One row of poster cards per media kind. A kind with no saved titles is left out. */
function recentHtml(recent: RecentResponse): string {
  const rows = (Object.keys(RECENT_HEADINGS) as RecentItem["kind"][])
    .filter((kind) => recent[kind]?.length)
    .map(
      (kind) => `
      <section class="recent-row">
        <div class="row-head">
          <h3>${RECENT_HEADINGS[kind]}</h3>
          <a href="#/browse?kind=${kind}">Browse all ${RECENT_HEADINGS[kind].toLowerCase()} →</a>
        </div>
        <ul class="cards">${recent[kind].map((item) => cardHtml(item, false, miniComposites(item))).join("")}</ul>
      </section>`,
    );
  return rows.length
    ? `<section class="recent"><h2>Recently added</h2>${rows.join("")}<p><a href="#/browse">Browse all rated titles →</a></p></section>`
    : "";
}

async function showHome(): Promise<string> {
  searchInput.value = "";
  // These lists are a bonus: if one fails to load, show the home page without it.
  const [trending, recent] = await Promise.all([api.trending().catch(() => []), api.recent().catch(() => null)]);
  return `
    <section class="hero">
      <h1>Know what is in it before your kids see it.</h1>
      <p>AI-generated summaries of movies, TV shows, and books for content that parents may want to know about.</p>
    </section>
    ${trendingHtml(trending)}
    ${recent ? recentHtml(recent) : ""}`;
}

// ---------- Browse ----------

// The filters live in the URL (#/browse?kind=movie&max.violence=2...), so a
// filtered list can be bookmarked or shared. The server reads the same query
// string; see src/server/browse.ts.

const MAX_OPTIONS: [value: string, label: string][] = [
  ["", "Any level"],
  ...Array.from({ length: SCORE_MAX }, (_, n): [string, string] => [String(n), n ? `${n} (${SCORE_LABELS[n]}) or less` : "None (0)"]),
];
const HIDE_TREATMENTS = TREATMENTS.filter((t) => t.id !== "not_present");

/**
 * Small stacked-bar icon for a poster card: one short bar per composite
 * (average, with the highest score striped behind it). Hover or focus shows
 * the numbers. Only topics the user has not hidden count.
 */
function miniComposites(t: Pick<RecentItem, "kind" | "scores">): string {
  const visible = new Set(visibleCategories(hidden).map((c) => c.id));
  const rows = COMPOSITES.flatMap((group) => {
    const result = summarize(group.categories.filter((id) => visible.has(id)).map((id) => t.scores[id]));
    return result ? [{ group, ...result }] : [];
  });
  if (!rows.length) return "";
  const upTo = t.kind === "tv" ? "up to " : "";
  const text = (r: (typeof rows)[number]) =>
    `${r.group.label}: ${upTo}${r.avg.toFixed(1)} / ${SCORE_MAX}${r.max > r.avg ? `, highest ${r.max}` : ""}`;
  const bars = rows
    .map(
      (r) => `
        <span class="bar layered">
          ${r.max > r.avg ? `<span class="bar-max" data-level="${r.max}" style="width:${pct(r.max)}"></span>` : ""}
          <span class="bar-avg" data-level="${Math.round(r.avg)}" style="width:${pct(r.avg)}"></span>
        </span>`,
    )
    .join("");
  const tip = rows
    .map(
      (r) =>
        `<span class="tip-row"><span>${esc(r.group.label)}</span><strong>${r.avg.toFixed(1)}</strong><span class="muted">${r.max > r.avg ? `highest ${r.max}` : ""}</span></span>`,
    )
    .join("");
  return `
    <span class="minibars" role="img" aria-label="${esc(rows.map(text).join("; "))}">
      <span class="minibars-icon" aria-hidden="true">${bars}</span>
      <span class="minibars-tip" aria-hidden="true">${upTo ? `<span class="tip-note muted">Up to, across seasons</span>` : ""}${tip}</span>
    </span>`;
}

function browseCards(items: IndexEntry[]): string {
  return items.map((t) => cardHtml(t, true, miniComposites(t))).join("");
}

/** One topic row: a level limit, and treatment checkboxes for topics that have a treatment. */
function topicFilter(c: Category, params: URLSearchParams): string {
  const max = params.get(`max.${c.id}`) ?? "";
  const hiddenTreatments = new Set(params.getAll(`hide.${c.id}`).flatMap((v) => v.split(",")));
  return `
    <div class="topic-filter">
      <label><span>${esc(c.label)}</span>
        <select name="max.${c.id}">${MAX_OPTIONS.map(([v, label]) => `<option value="${v}"${v === max ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>
      </label>
      ${
        c.hasTreatment
          ? `<span class="hide-treatments"><span class="muted small">Leave out:</span>${HIDE_TREATMENTS.map(
              (t) =>
                `<label class="chip-check" title="${esc(t.description)}"><input type="checkbox" name="hide.${c.id}" value="${t.id}"${hiddenTreatments.has(t.id) ? " checked" : ""} />${esc(t.label)}</label>`,
            ).join("")}</span>`
          : ""
      }
    </div>`;
}

/** Number of topic limits set in the query. */
function topicFilterCount(params: URLSearchParams): number {
  return new Set([...params.keys()].filter((k) => /^(max|hide)\./.test(k)).map((k) => k.replace(/^\w+\./, ""))).size;
}

/** Theme tag chips: selected tags first, then tags in the current results by count. */
function tagChips(res: BrowseResponse, selected: Set<string>): string {
  const counts = new Map(res.tags.map((t) => [t.tag as string, t.count]));
  const tags = [...selected, ...res.tags.map((t) => t.tag).filter((t) => !selected.has(t))];
  if (!tags.length) return `<span class="muted small">No theme tags in these results.</span>`;
  return tags
    .map(
      (tag) =>
        `<label class="chip-check"><input type="checkbox" name="tag" value="${esc(tag)}"${selected.has(tag) ? " checked" : ""} />${esc(tag.replace(/-/g, " "))} <span class="count">${counts.get(tag) ?? 0}</span></label>`,
    )
    .join("");
}

function browseResultsHtml(res: BrowseResponse): string {
  if (!res.total) return `<p class="status">No titles match these filters.</p>`;
  return `
    <p class="muted">${res.total} title${res.total === 1 ? "" : "s"}</p>
    <ul class="cards grid">${browseCards(res.items)}</ul>
    ${res.items.length < res.total ? `<p><button type="button" class="button" data-more="${res.items.length}">Show more</button></p>` : ""}`;
}

/** The query string for the current form values. Empty values are left out. */
function browseParams(form: HTMLFormElement): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    if (typeof value === "string" && value.trim() && !(key === "sort" && value === "added")) params.append(key, value.trim());
  }
  return params;
}

async function showBrowse(query: string): Promise<string> {
  searchInput.value = "";
  setLoading("Loading titles…");
  const params = new URLSearchParams(query);
  const res = await api.browse(params.toString());
  const kind = params.get("kind") ?? "";
  const sort = params.get("sort") ?? "added";
  const selectedTags = new Set(params.getAll("tag").filter((t) => (THEME_TAGS as readonly string[]).includes(t)));
  // Show the topics the user has not hidden, and any topic the URL filters on.
  const topics = CATEGORIES.filter((c) => !hidden.has(c.id) || params.has(`max.${c.id}`) || params.has(`hide.${c.id}`));
  const limits = topicFilterCount(params);

  return `
    <h1>Browse rated titles</h1>
    <form id="browse-form" class="browse-form">
      <div class="browse-row">
        <label><span>Type</span>
          <select name="kind">
            <option value="">All</option>
            ${SEARCH_KINDS.map((k) => `<option value="${k.kind}"${k.kind === kind ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
          </select>
        </label>
        <label><span>Title</span><input type="search" name="q" value="${esc(params.get("q") ?? "")}" placeholder="Title contains" /></label>
        <label><span>Sort by</span>
          <select name="sort">
            ${[["added", "Recently added"], ["title", "Title"], ["year", "Year (newest)"]]
              .map(([v, label]) => `<option value="${v}"${v === sort ? " selected" : ""}>${label}</option>`)
              .join("")}
          </select>
        </label>
        <button type="button" data-browse-clear>Clear filters</button>
      </div>
      <details class="topic-filters"${limits ? " open" : ""}>
        <summary>Topic limits <span class="count" id="limit-count">${limits ? `(${limits} set)` : ""}</span></summary>
        ${CATEGORY_SECTIONS.map((section) => {
          const rows = topics.filter((c) => c.section === section.id).map((c) => topicFilter(c, params)).join("");
          return rows ? `<fieldset class="pref-section"><legend>${esc(section.label)}</legend>${rows}</fieldset>` : "";
        }).join("")}
        <p class="muted small">TV series use their highest level across rated seasons. "Leave out" removes a title if any rated season has that treatment.</p>
      </details>
      <div class="tag-chips" id="browse-tags" aria-label="Theme tags">${tagChips(res, selectedTags)}</div>
    </form>
    <div id="browse-results">${browseResultsHtml(res)}</div>`;
}

// Each filter change gets a number, so a slow response cannot overwrite a newer one.
let browseSeq = 0;

/** Apply the form to the URL and reload the results, without rebuilding the form. */
async function updateBrowse(form: HTMLFormElement): Promise<void> {
  const seq = ++browseSeq;
  const params = browseParams(form);
  history.replaceState(null, "", `#/browse${params.size ? `?${params}` : ""}`);
  const limits = topicFilterCount(params);
  document.querySelector("#limit-count")!.textContent = limits ? `(${limits} set)` : "";
  const results = document.querySelector<HTMLElement>("#browse-results")!;
  results.setAttribute("aria-busy", "true");
  try {
    const res = await api.browse(params.toString());
    if (seq !== browseSeq) return;
    results.innerHTML = browseResultsHtml(res);
    watchMore();
    document.querySelector("#browse-tags")!.innerHTML = tagChips(res, new Set(params.getAll("tag")));
  } catch (err) {
    if (seq === browseSeq) results.innerHTML = errorHtml(err);
  } finally {
    if (seq === browseSeq) results.removeAttribute("aria-busy");
  }
}

/** Add the next page of results below the current ones. */
// Infinite scroll: load the next page when the "Show more" button comes near
// the viewport. The button stays as a fallback for keyboards and old browsers.
const moreObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) void showMoreBrowse(e.target as HTMLButtonElement);
        },
        { rootMargin: "600px 0px" },
      )
    : null;

/** Watch the current "Show more" button, if any. Observing again also re-checks a button already in view. */
function watchMore(): void {
  if (!moreObserver) return;
  moreObserver.disconnect();
  const button = app.querySelector<HTMLButtonElement>("#browse-results button[data-more]");
  if (button) moreObserver.observe(button);
}

async function showMoreBrowse(button: HTMLButtonElement): Promise<void> {
  const form = document.querySelector<HTMLFormElement>("#browse-form");
  // Already loading, or the page has changed since.
  if (!form || button.disabled || !button.isConnected) return;
  const params = browseParams(form);
  params.set("offset", button.dataset.more!);
  button.disabled = true;
  try {
    const res = await api.browse(params.toString());
    document.querySelector("#browse-results .cards")?.insertAdjacentHTML("beforeend", browseCards(res.items));
    const shown = res.offset + res.items.length;
    if (shown < res.total) {
      button.dataset.more = String(shown);
      button.disabled = false;
      // A tall screen can still show the button after this page: load the next one too.
      watchMore();
    } else button.remove();
  } catch (err) {
    button.insertAdjacentHTML("afterend", errorHtml(err));
    button.remove();
  }
}

let browseTyping: ReturnType<typeof setTimeout> | undefined;

app.addEventListener("change", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("#browse-form");
  if (form && (e.target as HTMLElement).getAttribute("name") !== "q") void updateBrowse(form);
});

app.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const form = input.closest<HTMLFormElement>("#browse-form");
  if (!form || input.name !== "q") return;
  clearTimeout(browseTyping);
  browseTyping = setTimeout(() => void updateBrowse(form), 300);
});

app.addEventListener("submit", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("#browse-form");
  if (!form) return;
  e.preventDefault();
  clearTimeout(browseTyping);
  void updateBrowse(form);
});

// ---------- Routing ----------

// Each navigation gets a number, so a slow response cannot overwrite a newer view.
let navSeq = 0;

/** Work a view needs after its HTML is on the page (e.g. filling in a slow part). Views set it. */
let afterRender: (() => void) | null = null;

/** Line for the site footer about the current page (e.g. the rating date). Views set it. */
let pageMeta = "";
const pageMetaEl = document.querySelector<HTMLElement>("#page-meta")!;

async function route(): Promise<void> {
  const seq = ++navSeq;
  pageMeta = "";
  afterRender = null;
  const hash = location.hash.replace(/^#/, "") || "/";
  let html: string;
  try {
    let m: RegExpExecArray | null;
    if ((m = /^\/search\?q=(.+)$/.exec(hash))) html = await showSearch(decodeURIComponent(m[1]!));
    else if ((m = /^\/r\/([\w-]+)$/.exec(hash))) html = await showReport(m[1]!);
    else if ((m = /^\/tv\/(\d+)$/.exec(hash))) html = await showSeries(m[1]!);
    else if ((m = /^\/browse(?:\?(.*))?$/.exec(hash))) html = await showBrowse(m[1] ?? "");
    else html = await showHome();
  } catch (err) {
    html = errorHtml(err);
  }
  if (seq !== navSeq) return;
  app.innerHTML = html;
  watchMore();
  // The cast undoes TypeScript's narrowing to null: the awaited view above may have set it.
  const after = afterRender as (() => void) | null;
  afterRender = null;
  after?.();
  pageMetaEl.textContent = pageMeta;
  pageMetaEl.hidden = !pageMeta;
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length >= 2) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

app.addEventListener("click", (e) => {
  const filter = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]")?.dataset.filter;
  if (filter) {
    saveSearchFilter(filter as SearchFilter);
    applySearchFilter(filter as SearchFilter);
    return;
  }

  const more = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-more]");
  if (more) {
    void showMoreBrowse(more);
    return;
  }

  if ((e.target as HTMLElement).closest("button[data-browse-clear]")) {
    // Filter changes replace the URL without a hashchange event, so the hash may already match.
    clearTimeout(browseTyping);
    if (location.hash === "#/browse") void route();
    else location.hash = "#/browse";
    return;
  }

  const id = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-jump]")?.dataset.jump;
  if (!id) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
});

window.addEventListener("hashchange", () => void route());
renderPrefs();
void route();
