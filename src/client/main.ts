import "./style.css";
import { CATEGORIES, SCORE_LABELS, SCORE_MAX, type CategoryId } from "../shared/categories.js";
import type { CategoryRange, Report, SearchResult, SeriesResponse } from "../shared/types.js";
import { api } from "./api.js";
import { loadHidden, saveHidden, visibleCategories } from "./prefs.js";

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
    ${CATEGORIES.map(
      (c) => `
      <label class="pref">
        <input type="checkbox" value="${c.id}" ${hidden.has(c.id) ? "" : "checked"} />
        <span>${esc(c.label)}</span>
      </label>`,
    ).join("")}`;
}

prefsBody.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  const id = box.value as CategoryId;
  if (box.checked) hidden.delete(id);
  else hidden.add(id);
  saveHidden(hidden);
  void route(); // Re-render the current view with the new filter.
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

function setLoading(message: string): void {
  app.innerHTML = `<p class="status"><span class="spinner" aria-hidden="true"></span>${esc(message)}</p>`;
}

function errorHtml(err: unknown): string {
  return `<p class="status error">${esc((err as Error).message)}</p>`;
}

function reportCard(report: Report, stale?: boolean): string {
  const rows = visibleCategories(hidden)
    .map((c) => {
      const r = report.categories[c.id];
      if (!r) return "";
      return `
      <tr>
        <th scope="row">${esc(c.label)}</th>
        <td class="score">${scoreBar(r.score)}<span class="score-label">${r.score} · ${esc(SCORE_LABELS[r.score])}</span></td>
        <td>${esc(r.notes)}</td>
      </tr>`;
    })
    .join("");
  const hiddenCount = CATEGORIES.length - visibleCategories(hidden).length;
  return `
    <section class="card">
      <p class="summary">${esc(report.summary)}</p>
      ${report.confidence === "low" ? `<p class="notice">The AI knows this work only a little. Details can be wrong.</p>` : ""}
      ${stale ? `<p class="notice">This result could not be refreshed just now. It may be out of date.</p>` : ""}
      <table class="ratings">
        <thead><tr><th>Topic</th><th>Level</th><th>Details</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="muted">All topics are hidden. Change "My concerns" to see them.</td></tr>`}</tbody>
      </table>
      ${hiddenCount ? `<p class="muted small">${hiddenCount} topic(s) hidden by your preferences.</p>` : ""}
      <p class="muted small">Rated ${esc(new Date(report.refreshedAt).toLocaleDateString())} by ${esc(report.model)} · confidence: ${esc(report.confidence)}</p>
    </section>`;
}

// ---------- Views ----------

async function showSearch(q: string): Promise<string> {
  searchInput.value = q;
  setLoading(`Searching for "${q}"…`);
  const { results, warnings } = await api.search(q);
  return `
    <h1>Results for "${esc(q)}"</h1>
    ${warnings.map((w) => `<p class="notice">${esc(w)}</p>`).join("")}
    ${
      results.length
        ? `<ul class="results">${results
            .map(
              (r) => `
          <li>
            <a href="${r.kind === "tv" ? `#/tv/${r.id.replace("tmdb-tv-", "")}` : `#/r/${r.id}`}">
              ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" alt="" loading="lazy" />` : `<span class="noimg" aria-hidden="true"></span>`}
              <span class="result-text">
                <strong>${esc(r.title)}</strong> ${r.year ? `<span class="muted">(${r.year})</span>` : ""}
                <span class="badge">${KIND_LABEL[r.kind]}</span>
                ${r.detail ? `<span class="muted small block">${esc(r.detail)}</span>` : ""}
              </span>
            </a>
          </li>`,
            )
            .join("")}</ul>`
        : `<p class="status">No matches. Try another spelling.</p>`
    }`;
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
  return `${back}
    <h1>${esc(r.title)}${r.subtitle ? ` <span class="muted">— ${esc(r.subtitle)}</span>` : ""}</h1>
    ${reportCard(r, res.stale)}`;
}

async function showSeries(tmdbId: string): Promise<string> {
  setLoading("Loading series…");
  const s: SeriesResponse = await api.series(tmdbId);
  const agg = s.aggregate;
  const aggRows = visibleCategories(hidden)
    .map((c) => {
      const range = agg.categories[c.id];
      if (!range) return "";
      const text = range.min === range.max ? `${range.max}` : `${range.min}–${range.max}`;
      return `<tr><th scope="row">${esc(c.label)}</th><td class="score">${rangeBar(range)}<span class="score-label">${text}</span></td></tr>`;
    })
    .join("");

  return `
    <h1>${esc(s.title)} ${s.year ? `<span class="muted">(${s.year})</span>` : ""}</h1>
    ${s.overview ? `<p>${esc(s.overview)}</p>` : ""}
    <section class="card">
      <h2>Whole series</h2>
      ${
        agg.ratedSeasons
          ? `${agg.partial ? `<p class="notice">Partial: based on ${agg.ratedSeasons} of ${agg.releasedSeasons} released seasons. Rate more seasons below to complete it.</p>` : ""}
             <table class="ratings"><tbody>${aggRows}</tbody></table>`
          : `<p class="muted">No seasons rated yet. Select a season below.</p>`
      }
    </section>
    <h2>Seasons</h2>
    <ul class="seasons">
      ${s.seasons
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
        .join("")}
    </ul>`;
}

function showHome(): string {
  searchInput.value = "";
  return `
    <section class="hero">
      <h1>Know what is in it before your kids see it.</h1>
      <p>Search for a movie, TV show, or book. You get an AI summary of content that parents may want to know about: violence, language, sexual content, and more.</p>
      <p class="muted">Use "My concerns" to choose the topics you care about.</p>
    </section>`;
}

// ---------- Routing ----------

// Each navigation gets a number, so a slow response cannot overwrite a newer view.
let navSeq = 0;

async function route(): Promise<void> {
  const seq = ++navSeq;
  const hash = location.hash.replace(/^#/, "") || "/";
  let html: string;
  try {
    let m: RegExpExecArray | null;
    if ((m = /^\/search\?q=(.+)$/.exec(hash))) html = await showSearch(decodeURIComponent(m[1]!));
    else if ((m = /^\/r\/([\w-]+)$/.exec(hash))) html = await showReport(m[1]!);
    else if ((m = /^\/tv\/(\d+)$/.exec(hash))) html = await showSeries(m[1]!);
    else html = showHome();
  } catch (err) {
    html = errorHtml(err);
  }
  if (seq === navSeq) app.innerHTML = html;
}

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length >= 2) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

window.addEventListener("hashchange", () => void route());
renderPrefs();
void route();
