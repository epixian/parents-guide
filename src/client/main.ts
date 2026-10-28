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
import { DEPTH_LABELS, DEPTH_MAX, FEELING_LABELS, FEELING_MAX, MOOD_SCALES, TONE_LABELS, TONE_MAX, hasMood } from "../shared/mood.js";
import { THEME_TAGS } from "../shared/themes.js";
import { BOOK_CATEGORIES, BOOK_CATEGORY_BY_ID, BOOK_CATEGORY_GROUPS, type BookCategory } from "../shared/bookCategories.js";
import type {
  AudienceScore,
  BrowseResponse,
  CategoryRange,
  CreditEntry,
  IndexEntry,
  Mood,
  RecentItem,
  RecentResponse,
  Report,
  SearchResult,
  SeriesResponse,
  Suggestion,
  WatchOffer,
  WatchProvider,
  WorkInfo,
} from "../shared/types.js";
import { api } from "./api.js";
import { recommend } from "../shared/recommend.js";
import { rankSimilar } from "../shared/similar.js";
import { type Fit, fitFor, markSignals, MIN_MARKED, type TasteModel } from "../shared/taste.js";
import { onMyServices, parseBrowseQuery, withinLimits } from "../shared/browse.js";
import { tasteModelFor } from "./tasteClient.js";
import { deleteTitles } from "./titleStore.js";
import { makeBackup, parseBackup, restoreBackup } from "./backup.js";
import { deleteFromDrive, driveClientId, loadFromDrive, saveToDrive } from "./drive.js";
import { idPath, pathId, titlePath } from "../shared/paths.js";
import { browse, prefetchTitles, preloadSearch, suggest, titleList, titlesById, titlesReady } from "./titles.js";
import {
  driveUsed,
  setDriveUsed,
  loadHidden,
  loadLimits,
  loadHiddenProviders,
  loadNotInterested,
  loadThumbs,
  loadWatchlist,
  markTipSeen,
  saveHidden,
  saveHiddenProviders,
  saveLimits,
  limitParams,
  saveNotInterested,
  saveThumbs,
  saveWatchlist,
  tipSeen,
  visibleCategories,
  type Thumb,
  type WatchlistEntry,
} from "./prefs.js";

const app = document.querySelector<HTMLElement>("#app")!;
const searchForm = document.querySelector<HTMLFormElement>("#search-form")!;
const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;

let hidden = loadHidden();
let hiddenProviders = loadHiddenProviders();
let limits = loadLimits();

const esc = (s: string | number | null | undefined): string =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const KIND_LABEL: Record<SearchResult["kind"], string> = { movie: "Movie", tv: "TV series", book: "Book" };

// ---------- Preferences page ----------

// /preferences: the topics the user cares about, the concern limits that
// Browse applies, and the streaming services the user has. Every change is
// saved at once, without rebuilding the page.

const MAX_OPTIONS: [value: string, label: string][] = [
  ["", "Any level"],
  ...Array.from({ length: SCORE_MAX }, (_, n): [string, string] => [String(n), n ? `${n} (${SCORE_LABELS[n]}) or less` : "None (0)"]),
];
const HIDE_TREATMENTS = TREATMENTS.filter((t) => t.id !== "not_present");

/** One topic: a show checkbox, then a level limit and treatments to leave out. A hidden topic's limits do not apply. */
function concernRow(c: Category): string {
  const off = hidden.has(c.id) ? " disabled" : "";
  const max = String(limits.max[c.id] ?? "");
  const left = new Set<string>(limits.hide[c.id] ?? []);
  return `
    <div class="concern-row${off ? " is-hidden" : ""}" data-topic="${c.id}">
      <label class="pref"><input type="checkbox" data-show value="${c.id}"${off ? "" : " checked"} /><span>${esc(c.label)}</span></label>
      <select data-max="${c.id}" aria-label="Highest level for ${esc(c.label)}"${off}>${MAX_OPTIONS.map(([v, label]) => `<option value="${v}"${v === max ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>
      ${
        c.hasTreatment
          ? `<span class="hide-treatments"><span class="muted small">Leave out:</span>${HIDE_TREATMENTS.map(
              (t) =>
                `<label class="chip-check" title="${esc(t.description)}"><input type="checkbox" data-hide="${c.id}" value="${t.id}"${left.has(t.id) ? " checked" : ""}${off} />${esc(t.label)}</label>`,
            ).join("")}</span>`
          : ""
      }
    </div>`;
}

function concernsHtml(): string {
  return `
    <p class="pref-actions">
      <button type="button" data-topics="show">Show all</button>
      <button type="button" data-topics="hide">Hide all</button>
      <button type="button" data-topics="clear">Clear limits</button>
    </p>
    ${CATEGORY_SECTIONS.map(
      (section) => `
      <fieldset class="pref-section">
        <legend>${esc(section.label)}</legend>
        ${CATEGORIES.filter((c) => c.section === section.id).map(concernRow).join("")}
      </fieldset>`,
    ).join("")}`;
}

function showPreferences(): string {
  searchInput.value = "";
  pageTitle = "Preferences";
  dismissTip();
  afterRender = loadServices;
  return `
    <h1>Preferences</h1>
    <section class="prefs-section">
      <h2>Concerns</h2>
      <p class="muted">Uncheck the topics you do not want to see. Set a highest level or treatments to leave out, and Browse hides the titles over your limits. TV series use their highest level across rated seasons.</p>
      <div id="concerns">${concernsHtml()}</div>
    </section>
    <section class="prefs-section">
      <h2>My services</h2>
      <div id="services-body"><p class="status"><span class="spinner" aria-hidden="true"></span>Loading services…</p></div>
    </section>${dataHtml()}`;
}

/** "Your data": the Google Drive backup (when the build has a client ID), and Delete all data. */
function dataHtml(): string {
  const drive = driveClientId
    ? `
      <p class="muted">Save your choices, watchlist, and thumbs to a hidden app folder in your Google Drive. Restore them on another device. The app sees only its own folder, not your other files.</p>
      <p class="pref-actions">
        <button type="button" data-data="save">Back up to Google Drive</button>
        <button type="button" data-data="restore">Restore from Google Drive</button>
        <button type="button" data-data="delete"${driveUsed() ? "" : " hidden"}>Delete backup</button>
      </p>
      <dialog id="delete-dialog" class="modal" aria-labelledby="delete-dialog-title">
        <form method="dialog">
          <h2 id="delete-dialog-title">Delete the backup?</h2>
          <p>This deletes the backup from your Google Drive, and removes this site's access to your Drive. You cannot undo this.</p>
          <p class="muted small">The choices, watchlist, and thumbs on this device stay.</p>
          <p class="modal-actions">
            <button value="cancel" autofocus>Cancel</button>
            <button value="delete" class="danger">Delete backup</button>
          </p>
        </form>
      </dialog>`
    : "";
  return `
    <section class="prefs-section" id="your-data">
      <h2>Your data</h2>${drive}
      <p class="muted">Delete all data removes everything this site saved in this browser.</p>
      <p class="pref-actions">
        <button type="button" data-data="clear">Delete all data</button>
      </p>
      <p id="data-status" class="data-status muted small" role="status"></p>
      <dialog id="clear-dialog" class="modal" aria-labelledby="clear-dialog-title">
        <form method="dialog">
          <h2 id="clear-dialog-title">Delete all data?</h2>
          <p>This deletes your choices, limits, streaming services, watchlist, thumbs, and the saved title list from this browser. You cannot undo this.</p>
          ${
            driveClientId
              ? `<label class="pref" id="clear-drive"><input type="checkbox" name="drive" /> Also delete the backup in Google Drive</label>`
              : ""
          }
          <p class="modal-actions">
            <button value="cancel" autofocus>Cancel</button>
            <button value="clear" class="danger">Delete all data</button>
          </p>
        </form>
      </dialog>
    </section>`;
}

app.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("#your-data .pref-actions button[data-data]");
  if (!button) return;
  // Deletes ask first, in a dialog; "Cancel" has the focus, so Enter does not delete.
  const action = button.dataset.data as DataAction;
  if (action === "delete" || action === "clear") {
    const dialog = document.querySelector<HTMLDialogElement>(`#${action}-dialog`)!;
    dialog.querySelector("form")!.reset();
    // The Drive choice only after this browser used the backup, like "Delete backup".
    const drive = dialog.querySelector<HTMLElement>("#clear-drive");
    if (drive) drive.hidden = !driveUsed();
    dialog.showModal();
  } else void runData(action);
});

// The dialog's form closes it with the clicked button's value (Escape leaves it empty).
app.addEventListener(
  "close",
  (e) => {
    const dialog = e.target as HTMLDialogElement;
    if (dialog.id === "delete-dialog" && dialog.returnValue === "delete") void runData("delete");
    if (dialog.id === "clear-dialog" && dialog.returnValue === "clear") {
      void runData("clear", !!dialog.querySelector<HTMLInputElement>('input[name="drive"]')?.checked);
    }
  },
  true, // "close" does not bubble.
);

type DataAction = "save" | "restore" | "delete" | "clear";

/** Everything the app saves in this browser: localStorage, the title list in IndexedDB, and the offline caches. */
async function clearAllData(): Promise<void> {
  try {
    localStorage.clear();
  } catch {
    // Storage blocked: nothing saved.
  }
  await deleteTitles();
  // The service worker saves the page and API answers here; it fills them again as pages load.
  if ("caches" in window) for (const key of await caches.keys()) await caches.delete(key);
}

/** clearDrive: with "clear", also delete the Drive backup. */
async function runData(action: DataAction, clearDrive = false): Promise<void> {
  const status = document.querySelector<HTMLElement>("#data-status")!;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#your-data .pref-actions button")];
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };
  /** Delete shows only while this browser has access to the user's Drive. */
  const connected = (used: boolean) => {
    setDriveUsed(used);
    document.querySelector<HTMLButtonElement>('#your-data button[data-data="delete"]')!.hidden = !used;
  };
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (action === "save") {
      say("Backing up…");
      await saveToDrive(JSON.stringify(makeBackup(localStorage)));
      connected(true);
      say(`Backed up ${new Date().toLocaleString()}.`);
    } else if (action === "clear") {
      if (clearDrive) {
        say("Deleting the backup…");
        await deleteFromDrive();
      }
      say("Deleting all data…");
      await clearAllData();
      // Back to the home page, which reads the empty storage.
      location.replace("/");
    } else if (action === "delete") {
      say("Deleting the backup…");
      const n = await deleteFromDrive();
      connected(false);
      say(n ? "Deleted the backup, and removed this site's access to your Drive." : "There was no backup. Removed this site's access to your Drive.");
    } else {
      say("Loading the backup…");
      const text = await loadFromDrive();
      connected(true);
      const backup = text === null ? null : parseBackup(text);
      if (!backup) return say(text === null ? "There is no backup in your Google Drive." : "The backup file is not valid.", true);
      const when = new Date(backup.savedAt).toLocaleString();
      if (!confirm(`Replace the choices, watchlist, and thumbs on this device with the backup from ${when}?`)) return say("");
      restoreBackup(localStorage, backup);
      // The page keeps the choices in memory; a reload reads the restored ones.
      location.reload();
    }
  } catch (err) {
    say((err as Error).message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

app.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement | HTMLSelectElement;
  const row = input.closest<HTMLElement>("#concerns .concern-row");
  if (!row) return;
  const id = row.dataset.topic as CategoryId;
  if (input instanceof HTMLInputElement && input.hasAttribute("data-show")) {
    if (input.checked) hidden.delete(id);
    else hidden.add(id);
    saveHidden(hidden);
    row.classList.toggle("is-hidden", !input.checked);
    for (const el of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input[data-hide]")) el.disabled = !input.checked;
    return;
  }
  if (input instanceof HTMLSelectElement) {
    if (input.value) limits.max[id] = Number(input.value);
    else delete limits.max[id];
  } else {
    const ids = [...row.querySelectorAll<HTMLInputElement>("input[data-hide]:checked")].map((box) => box.value as TreatmentId);
    if (ids.length) limits.hide[id] = ids;
    else delete limits.hide[id];
  }
  saveLimits(limits);
});

app.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("#concerns button[data-topics]")?.dataset.topics;
  if (!action) return;
  if (action === "clear") {
    limits = { max: {}, hide: {} };
    saveLimits(limits);
  } else {
    hidden = action === "hide" ? new Set(CATEGORIES.map((c) => c.id)) : new Set();
    saveHidden(hidden);
  }
  document.querySelector("#concerns")!.innerHTML = concernsHtml();
});

// First-visit tip next to the Preferences link. Opening the page also counts as seen.
const tip = document.querySelector<HTMLElement>("#concerns-tip")!;

function dismissTip(): void {
  if (tip.hidden) return;
  tip.hidden = true;
  markTipSeen();
}

tip.hidden = tipSeen();
document.querySelector("#concerns-tip-close")!.addEventListener("click", dismissTip);

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

// ---------- Streaming services ----------

/** Every service, loaded the first time the Preferences page opens. */
let catalog: WatchProvider[] | null = null;

/** A service's logo. In "My services" the name follows it, so the logo has no alt text there. */
function serviceLogo(p: WatchProvider, size: number, alt = ""): string {
  return p.logoUrl
    ? `<img class="service-logo" src="${esc(p.logoUrl)}" alt="${esc(alt)}" width="${size}" height="${size}" loading="lazy" decoding="async" />`
    : `<span class="service-logo noimg" aria-hidden="true" style="width:${size}px;height:${size}px"></span>`;
}

function serviceChoice(p: WatchProvider): string {
  return `
      <label class="pref" data-name="${esc(p.name.toLowerCase())}">
        <input type="checkbox" value="${p.ids.join(",")}" ${providerShown(p) ? "checked" : ""} />
        ${serviceLogo(p, 24)}
        <span>${esc(p.name)}</span>
      </label>`;
}

function renderServices(): void {
  const body = document.querySelector<HTMLElement>("#services-body");
  if (!catalog || !body) return;
  const others = catalog.filter((p) => p.rank === null);
  body.innerHTML = `
    <p class="muted">Uncheck the services you do not have. Titles show only the checked services.</p>
    <p class="pref-actions">
      <button type="button" data-all="show">Show all</button>
      <button type="button" data-all="hide">Hide all</button>
    </p>
    <input type="search" class="service-find" placeholder="Find a service" aria-label="Find a service" />
    <div class="service-list">
      ${catalog.filter((p) => p.rank !== null).map(serviceChoice).join("")}
      <details class="other-services">
        <summary>Other services (${others.length})</summary>
        ${others.map(serviceChoice).join("")}
      </details>
    </div>`;
}

/** Fill "My services" on the Preferences page. The list loads from the server once. */
function loadServices(): void {
  if (catalog) return renderServices();
  api
    .providers()
    .then((list) => {
      catalog = list;
      renderServices();
    })
    .catch((err: unknown) => {
      const body = document.querySelector<HTMLElement>("#services-body");
      if (body) body.innerHTML = errorHtml(err);
    });
}

app.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.type !== "checkbox" || !box.closest("#services-body")) return;
  for (const id of box.value.split(",").map(Number)) {
    if (box.checked) hiddenProviders.delete(id);
    else hiddenProviders.add(id);
  }
  saveHiddenProviders(hiddenProviders);
});

app.addEventListener("input", (e) => {
  const find = e.target as HTMLInputElement;
  const body = find.closest<HTMLElement>("#services-body");
  if (!body || !find.classList.contains("service-find")) return;
  const text = find.value.trim().toLowerCase();
  // Search every service, not only the major ones.
  const other = body.querySelector<HTMLDetailsElement>(".other-services");
  if (other && text) other.open = true;
  for (const label of body.querySelectorAll<HTMLElement>(".service-list .pref")) {
    label.hidden = Boolean(text) && !label.dataset.name!.includes(text);
  }
});

app.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("#services-body button[data-all]")?.dataset.all;
  if (!action || !catalog) return;
  hiddenProviders = action === "hide" ? new Set(catalog.flatMap((p) => p.ids)) : new Set();
  saveHiddenProviders(hiddenProviders);
  renderServices();
});

/** Services per title id, kept for one hour so a re-render does not ask again. The server keeps them for a day. */
const watchCache = new Map<string, { at: number; providers: WatchProvider[] }>();
/** Services of the title on the current page, or null while they load (or for books). */
let pageProviders: WatchProvider[] | null = null;

function cachedWatch(id: string): WatchProvider[] | null {
  const hit = watchCache.get(id);
  return hit && Date.now() - hit.at < 60 * 60 * 1000 ? hit.providers : null;
}

/** A brand shows unless the user hid every service in it. */
const providerShown = (p: WatchProvider) => p.ids.some((id) => !hiddenProviders.has(id));

/** Added to the tooltip after the service name. */
const OFFER_NOTE: Record<WatchOffer, string> = { subscription: "", ads: " (free with ads)" };

/** Logos on the streaming line before the "more" link. */
const WATCH_FIRST = 3;
/** Title id whose streaming line the user expanded with "more". Kept when the page is drawn again. */
let watchExpandedFor: string | null = null;

/** Inner HTML of the streaming line: logos of the services the user has not hidden. Empty when there are none. */
function watchHtml(providers: WatchProvider[]): string {
  const shown = providers.filter(providerShown);
  if (!shown.length) return "";
  const visible = watchExpandedFor === watchId ? shown : shown.slice(0, WATCH_FIRST);
  const items = visible.map((p) => {
    const tip = `Streaming on ${p.name}${OFFER_NOTE[p.offer ?? "subscription"]}`;
    return p.logoUrl
      ? `<li title="${esc(tip)}">${serviceLogo(p, 32, tip)}</li>`
      : `<li class="watch-name" title="${esc(tip)}">${esc(p.name)}</li>`;
  });
  const more = shown.length - visible.length;
  return `<ul class="watch-list" aria-label="Streaming on">${items.join("")}</ul>${
    more ? `<button type="button" class="watch-more" data-watch-more>+${more} more</button>` : ""
  }`;
}

/** The streaming line, filled when the services arrive. Hidden when no service shows. */
function watchLine(): string {
  const ready = pageProviders !== null;
  const html = pageProviders ? watchHtml(pageProviders) : "";
  // A div, not a p: a p cannot hold the list.
  return `<div class="watch" id="watch-slot"${html ? "" : " hidden"}${ready ? "" : ` aria-busy="true"`}>${html}</div>`;
}

/** Show the current page's services again, e.g. after the user asks for all of them. */
function renderWatch(): void {
  const slot = document.querySelector<HTMLElement>("#watch-slot");
  if (!slot || pageProviders === null) return;
  slot.removeAttribute("aria-busy");
  const html = watchHtml(pageProviders);
  slot.hidden = !html;
  slot.innerHTML = html;
}

/** Load the services for the title on the page; no-op when they came from the cache. */
function loadWatch(id: string, seq: number): void {
  if (pageProviders !== null) return;
  api
    .watch(id)
    .then((w) => {
      watchCache.set(id, { at: Date.now(), providers: w.providers });
      if (seq !== navSeq) return;
      pageProviders = w.providers;
      renderWatch();
    })
    .catch(() => {
      // Streaming services are extra: on an error, the line stays hidden.
      document.querySelector("#watch-slot")?.removeAttribute("aria-busy");
    });
}

// ---------- Similar titles ----------

/** Cards in the "Similar titles" section. */
const SIMILAR_LIMIT = 12;

/** Similar rated titles per title id, in TMDB's order, kept for one hour. */
const similarCache = new Map<string, { at: number; items: RecentItem[] }>();
/** Rated titles by id, for the theme tags of liked and similar titles. Null until loaded (or with data saver). */
let similarIndex: Map<string, IndexEntry> | null = null;

function cachedSimilar(): RecentItem[] | null {
  const hit = watchId ? similarCache.get(watchId) : undefined;
  return hit && Date.now() - hit.at < 60 * 60 * 1000 ? hit.items : null;
}

/** True when the page gets a "Similar titles" section: movies and TV, unless the list is known to be empty. */
const hasSimilar = () => Boolean(watchId) && cachedSimilar()?.length !== 0;

/** The first cards, after titles like the ones the user liked and before ones like those they did not (see rankSimilar). */
function similarCardsHtml(items: RecentItem[]): string {
  const signals = markSignals(thumbs, notInterested);
  const ranked = rankSimilar(items, signals, (id) => similarIndex?.get(id)?.themeTags).slice(0, SIMILAR_LIMIT);
  return `<ul class="cards">${ranked.map((item) => cardHtml(item, false, miniComposites(item))).join("")}</ul>`;
}

/** Order the similar titles on the page again, after the thumbs change. */
function rerankSimilar(): void {
  const box = document.querySelector<HTMLElement>("#similar-slot");
  const items = cachedSimilar();
  if (box && items?.length && !box.hasAttribute("aria-busy")) box.innerHTML = similarCardsHtml(items);
}

/** The "Similar titles" section, filled when the list arrives. Only rated titles show. */
function similarSection(): string {
  if (!hasSimilar()) return "";
  const items = cachedSimilar();
  const ready = items !== null;
  return `
    <section class="card section" id="sec-similar">
      ${sectionHead("Similar titles")}
      <div id="similar-slot"${ready ? "" : ` aria-busy="true"`}>
        ${ready ? similarCardsHtml(items) : `<p class="status"><span class="spinner" aria-hidden="true"></span>Loading similar titles…</p>`}
      </div>
    </section>`;
}

/** Load the similar titles for the page; no-op when they came from the cache. */
function loadSimilar(id: string, seq: number): void {
  const slot = document.querySelector<HTMLElement>("#similar-slot");
  if (!slot?.hasAttribute("aria-busy")) return;
  const fill = (items: RecentItem[]) => {
    const box = document.querySelector<HTMLElement>("#similar-slot");
    if (seq !== navSeq || !box) return;
    if (items.length) {
      box.innerHTML = similarCardsHtml(items);
      box.removeAttribute("aria-busy");
      return;
    }
    // No rated similar titles (or an error): remove the section and its jump link.
    document.querySelector("#sec-similar")?.remove();
    document.querySelectorAll('[data-jump="sec-similar"]').forEach((el) => el.remove());
  };
  // The catalog gives the theme tags for the order; without it, TMDB's order stays.
  Promise.all([api.similar(id), titlesById().catch(() => null)])
    .then(([items, index]) => {
      similarIndex = index ?? similarIndex;
      similarCache.set(id, { at: Date.now(), items });
      fill(items);
    })
    .catch(() => fill([]));
}

// ---------- Watchlist and thumbs ----------

let watchlist = loadWatchlist();
let thumbs = loadThumbs();
let notInterested = loadNotInterested();

/** Id for the watchlist and thumbs: a TV season uses its series. */
const markId = (id: string) => id.replace(/^(tmdb-tv-\d+)-s\d+$/, "$1");

/** What a watchlist entry saves about the title, apart from the time. */
type MarkTitle = Omit<WatchlistEntry, "addedAt">;

function markTitle(id: string, title: string, info: WorkInfo | undefined): MarkTitle {
  const kind = id.startsWith("ol-") ? "book" : id.startsWith("tmdb-tv-") ? "tv" : "movie";
  return { kind, title, years: info?.years ?? null, imageUrl: info?.imageUrl ?? null };
}

// Outlines from Feather icons (MIT). Filled: the same shape with fill.
const MARK_ICONS = {
  list: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  up: "M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3",
  down: "M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17",
};

function markButton(mark: keyof typeof MARK_ICONS, on: boolean, label: string, tip: string): string {
  return `
    <button type="button" class="mark" data-mark="${mark}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(tip)}">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${MARK_ICONS[mark]}" /></svg>
    </button>`;
}

/** Watchlist button, then thumbs up and down. Selecting one thumb turns the other off. */
function marksHtml(id: string, title: MarkTitle): string {
  const list = id.startsWith("ol-") ? "reading list" : "watchlist";
  const listed = id in watchlist;
  const thumb: Thumb | undefined = thumbs[id];
  return `
    <div class="marks" id="marks" data-id="${esc(id)}" data-title="${esc(JSON.stringify(title))}">
      ${markButton("list", listed, `On my ${list}`, listed ? `Remove from your ${list}` : `Add to your ${list}`)}
      ${markButton("up", thumb === "up", "I liked it", thumb === "up" ? "You liked it. Select to clear." : "I liked it")}
      <span class="marks-slash" aria-hidden="true">/</span>
      ${markButton("down", thumb === "down", "I did not like it", thumb === "down" ? "You did not like it. Select to clear." : "I did not like it")}
    </div>`;
}

function toggleMark(button: HTMLButtonElement): void {
  const box = button.closest<HTMLElement>("#marks")!;
  const id = box.dataset.id!;
  const title = JSON.parse(box.dataset.title!) as MarkTitle;
  const mark = button.dataset.mark!;
  if (mark === "list") {
    if (id in watchlist) delete watchlist[id];
    else watchlist[id] = { ...title, addedAt: new Date().toISOString() };
    saveWatchlist(watchlist);
  } else {
    const thumb = mark as Thumb;
    if (thumbs[id] === thumb) delete thumbs[id];
    else thumbs[id] = thumb;
    saveThumbs(thumbs);
    rerankSimilar();
    void refreshFit();
  }
  box.outerHTML = marksHtml(id, title);
  if (mark === "list") refreshListButtons(id);
  // Keep focus on the button the user selected; it is drawn again.
  document.querySelector<HTMLButtonElement>(`#marks [data-mark="${mark}"]`)?.focus();
}

// Another tab changed the lists: use its values.
window.addEventListener("storage", () => {
  watchlist = loadWatchlist();
  thumbs = loadThumbs();
  notInterested = loadNotInterested();
  const box = document.querySelector<HTMLElement>("#marks");
  if (box) {
    box.outerHTML = marksHtml(box.dataset.id!, JSON.parse(box.dataset.title!) as MarkTitle);
    refreshListButtons(box.dataset.id!);
  }
  rerankSimilar();
  void refreshFit();
});

// ---------- Fit hint ----------

/** "You might like this" on a title page, empty until refreshFit fills it. */
const fitSlot = (id: string) => `<p class="fit with-info" id="fit" data-id="${esc(id)}" hidden></p>`;

function fitHtml(fit: Fit): string {
  // "A", "A and B", or "A, B, and C".
  const names = new Intl.ListFormat("en").format(fit.likedNear.slice(0, 3).map((t) => esc(t.title)));
  return `
    <span>You might like this.</span>
    <span class="info-wrap">
      <button type="button" class="info-icon" aria-label="About this guess" aria-describedby="fit-info">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
      </button>
      <span class="info-tip" id="fit-info" role="tooltip">Similar to ${names}, which you also liked.</span>
    </span>`;
}

/** Show or hide the fit line for the page's title (see fitFor). Hidden without the rated titles. */
async function refreshFit(): Promise<void> {
  const slot = document.querySelector<HTMLElement>("#fit");
  if (!slot) return;
  // Too few marks for a fit: do not load the rated titles for nothing.
  const enough = markSignals(thumbs, notInterested).size >= MIN_MARKED;
  const index = enough ? await titlesById().catch(() => null) : null;
  const model = index ? await tasteModelFor(index, thumbs, notInterested) : null;
  // The user left the page while the list loaded or the titles were scored.
  if (!slot.isConnected) return;
  const fit = index ? fitFor(slot.dataset.id!, titleList(index), thumbs, notInterested, model) : null;
  slot.innerHTML = fit ? fitHtml(fit) : "";
  slot.hidden = !fit;
}

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

/**
 * Audience score from the catalog, in a badge. TMDB: "8.7/10" and TMDB's
 * logo. Others: "★ 4.2/5". The tooltip names the source and the vote count.
 */
function audienceHtml(a: AudienceScore | null | undefined, sourceUrl: string | undefined): string {
  if (!a) return "";
  const tip = `Average user score on ${a.source}: ${a.average.toFixed(1)} of ${a.scale}, from ${a.count.toLocaleString("en")} votes`;
  const score = esc(a.scale === 10 ? `${a.average.toFixed(1)}/10` : `★ ${a.average.toFixed(1)}/${a.scale}`);
  // TMDB's official short logo (themoviedb.org/about/logos-attribution), unchanged, next to the
  // score in our own white badge. Other sources get the badge with the score only.
  const logo = a.source === "TMDB" ? `<img class="audience-logo" src="/logos/tmdb.svg" alt="TMDB" width="77" height="10" />` : "";
  const inner = `<span class="audience-badge">${score}${logo}</span>`;
  return sourceUrl && /^https:\/\//.test(sourceUrl)
    ? `<a class="audience" href="${esc(sourceUrl)}" target="_blank" rel="noopener" title="${esc(tip)}">${inner}</a>`
    : `<span class="audience" title="${esc(tip)}">${inner}</span>`;
}

/** Title area: poster, title, year, rating, and the composites. Details go lower on the page. */
/** markFor: the page's report or series id, for the watchlist and thumbs. */
function titleHeader(
  title: string,
  subtitle: string | null,
  info: WorkInfo | undefined,
  composites: string,
  markFor: string,
  scores: Partial<Record<CategoryId, number>>,
): string {
  const facts = [
    // The title rail hides this year: its card shows it already.
    info?.years ? `<span class="fact-year">${esc(info.years)}</span>` : "",
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
      ${info?.imageUrl ? `<img class="poster" src="${esc(info.imageUrl)}" alt="" width="120" height="180" />` : ""}
      <div class="title-text">
        <h1>${esc(title)}${subtitle ? ` <span class="muted">— ${esc(subtitle)}</span>` : ""}</h1>
        ${byline ? `<p class="byline">by ${byline}</p>` : ""}
        ${facts.length ? `<p class="facts">${facts.join("")}</p>` : ""}
        ${watchId ? watchLine() : ""}
        ${marksHtml(markId(markFor), markTitle(markFor, title, info))}
        ${fitSlot(markId(markFor))}
      </div>
      ${composites}
    </section>
    ${titleRail(title, subtitle, info, markFor, scores)}`;
}

/**
 * Wide screens: the title's card (poster, composite bars, title, type and
 * year, watchlist toggle) and the page's jump links, always in the left margin
 * (see updateRail). The title area then has no poster of its own, so the
 * poster animation moves a whole card between a list and the rail. The card
 * scrolls to the top; the jump links are copied in by fillRailJumps after the
 * page renders.
 */
function titleRail(
  title: string,
  subtitle: string | null,
  info: WorkInfo | undefined,
  markFor: string,
  scores: Partial<Record<CategoryId, number>>,
): string {
  const card = { ...markTitle(markFor, title, info), id: markFor };
  // A series shows its highest score per topic ("up to"); one season does not.
  const bars = miniComposites({ kind: markFor.startsWith("tmdb-tv-") && !subtitle ? "tv" : "movie", scores });
  const meta = [KIND_LABEL[card.kind], subtitle, info?.years].filter(Boolean).map((t) => esc(t!)).join(" · ");
  return `
    <aside class="title-rail" data-rail aria-label="${esc(title)}">
      ${cardActions(card)}
      <button type="button" class="rail-link" data-top aria-label="${esc(`Back to the top of ${title}`)}">
        ${info?.imageUrl ? `<img class="rail-poster" src="${esc(info.imageUrl)}" alt="" width="176" height="264" />` : ""}
        ${bars}
        <span class="rail-title">${esc(title)}</span>
        <span class="muted small">${meta}</span>
      </button>
      <div class="rail-info" data-rail-info></div>
      <nav class="rail-jumps" data-rail-jumps aria-label="On this page"></nav>
    </aside>`;
}

/** Same width as the title rail's media query in style.css. */
const wideScreen = window.matchMedia("(min-width: 1344px)");

/**
 * Wide screens: move the title header (heading, byline, facts, streaming,
 * watchlist and thumbs) from the title area into the rail, below the card.
 * Narrower screens: put it back. Moving keeps one copy, so its ids and
 * handlers stay as they are.
 */
function placeTitleText(): void {
  const text = app.querySelector<HTMLElement>(".title-text");
  const slot = app.querySelector<HTMLElement>("[data-rail-info]");
  const area = app.querySelector<HTMLElement>(".title-area");
  if (!text || !slot || !area) return;
  if (wideScreen.matches) {
    if (text.parentElement !== slot) slot.append(text);
  } else if (text.parentElement !== area) {
    area.insertBefore(text, area.querySelector(".composites"));
  }
}

wideScreen.addEventListener("change", () => {
  placeTitleText();
  updateRail();
});

/** Copy the page's jump links into the rail, in the same order. */
function fillRailJumps(): void {
  const slot = app.querySelector<HTMLElement>("[data-rail-jumps]");
  const jumps = app.querySelector(".jumps");
  if (!slot) return;
  slot.innerHTML = jumps ? jumps.innerHTML : "";
  slot.hidden = !jumps;
}

/**
 * Wide screens show the rail on every title page (CSS hides it on narrow
 * ones). It starts level with the first card, below the site header, and
 * stays 16px from the top of the window when the page scrolls.
 */
function updateRail(): void {
  const rail = app.querySelector<HTMLElement>("[data-rail]");
  if (!rail) return;
  const shown = getComputedStyle(rail).display !== "none";
  rail.classList.toggle("shown", shown);
  rail.inert = !shown;
  if (!shown) return;
  // Level with the first card: the top of the column plus its 16px padding,
  // which is also the gap to the cards on the right and to the window top.
  const top = Math.max(16, app.getBoundingClientRect().top + 16);
  rail.style.top = `${top}px`;
  rail.style.maxHeight = `calc(100vh - ${top + 16}px)`;
}

window.addEventListener("resize", () => updateRail());

/**
 * The rail scrolls, so it would cut off a tooltip. In the rail the composite
 * and info tooltips are position: fixed (see style.css); this puts one to the
 * right of the rail, level with what shows it, on hover or focus.
 */
function placeRailTip(anchor: HTMLElement, tip: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  const rail = anchor.closest(".title-rail")!.getBoundingClientRect();
  tip.style.left = `${rail.right + 8}px`;
  tip.style.top = `${box.top}px`;
}

/** The composite bars or the info button under the event target, with its tooltip. */
function railTipFor(e: Event): [HTMLElement, HTMLElement] | null {
  const target = e.target as HTMLElement;
  const info = target.closest<HTMLElement>(".title-rail .info-wrap");
  const bars = target.closest(".title-rail .minibars, .title-rail .rail-link")
    ? target.closest(".title-rail")!.querySelector<HTMLElement>(".minibars")
    : null;
  const anchor = info ?? bars;
  const tip = anchor?.querySelector<HTMLElement>(".info-tip, .minibars-tip");
  return anchor && tip ? [anchor, tip] : null;
}
app.addEventListener("mouseover", (e) => {
  const found = railTipFor(e);
  if (found) placeRailTip(...found);
});
app.addEventListener("focusin", (e) => {
  const found = railTipFor(e);
  if (found) placeRailTip(...found);
});

/**
 * Mark the jump link of the section being read: the last one whose top is
 * above a line 30% down the window, or the last section at the page bottom.
 */
function updateJumps(): void {
  const buttons = [...app.querySelectorAll<HTMLButtonElement>(".jumps button[data-jump], .rail-jumps button[data-jump]")];
  if (!buttons.length) return;
  const ids = [...new Set(buttons.map((b) => b.dataset.jump!))];
  const sections = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
  const line = window.innerHeight * 0.3;
  let current = sections[0]?.id;
  for (const el of sections) if (el.getBoundingClientRect().top <= line) current = el.id;
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  if (atBottom && sections.length) current = sections[sections.length - 1]!.id;
  for (const b of buttons) {
    if (b.dataset.jump === current) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}

let railFrame = 0;
window.addEventListener(
  "scroll",
  () => {
    cancelAnimationFrame(railFrame);
    railFrame = requestAnimationFrame(() => {
      updateRail();
      updateJumps();
    });
  },
  { passive: true },
);

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

// ---------- Mood ----------
// A block in the Summary section with three titled bars: Outlook (the tone
// field, 1-5, bleak to uplifting: purple, grey, gold), Pull (the feeling
// field, 1-5, low-key to powerful: pale to deep rose), and Depth (1-5, silly to
// profound: light to deep blue).
// Like the concern bars, the width shows the value and the whole bar takes
// the value's color. Each scale is a tile, and the tile's tooltip explains
// the scale. The AI's one-sentence note is saved but not shown.

interface MoodRange {
  tone: CategoryRange;
  feeling: CategoryRange;
  depth: CategoryRange;
}

/** "Somber", or "Somber–Hopeful" for a range. */
function spanLabel(range: CategoryRange, labels: Record<number, string>): string {
  return range.min === range.max ? labels[range.min]! : `${labels[range.min]}–${labels[range.max]}`;
}

/**
 * One titled bar, in the style of the concern bars: the bar's width shows the
 * value, and its color comes from the value (--{scale}-{value} in style.css).
 * For a range, a solid layer goes to the lowest value and a striped layer
 * behind it to the highest. The value goes below the bar. Each scale is a
 * tile, and the tile's tooltip explains the scale.
 */
function moodScale(
  title: string,
  tip: string,
  value: string,
  range: CategoryRange | null,
  scale: "tone" | "feeling" | "depth",
  max: number,
): string {
  const layer = (cls: string, n: number) =>
    `<span class="${cls}" style="width: ${Math.round((n / max) * 100)}%; --fill: var(--${scale}-${n})"></span>`;
  const layers = !range ? "" : (range.max > range.min ? layer("bar-max", range.max) : "") + layer("bar-fill", range.min);
  return `
    <div class="composite mood-scale" title="${esc(tip)}">
      <span class="mood-title">${title}</span>
      <span class="bar mood-bar" aria-hidden="true">${layers}</span>
      <span class="mood-value">${value}</span>
    </div>`;
}

/** The three tiles. attrs: extra attributes for the block. */
function moodBlock(r: MoodRange | null, values: [string, string, string], attrs = ""): string {
  return `
    <div class="mood-block"${attrs}>
      ${moodScale("Outlook", "Where the story leaves you, from bleak to uplifting", values[0], r?.tone ?? null, "tone", TONE_MAX)}
      ${moodScale("Pull", "How strongly it stirs emotions", values[1], r?.feeling ?? null, "feeling", FEELING_MAX)}
      ${moodScale("Depth", "How much it gives you to think about", values[2], r?.depth ?? null, "depth", DEPTH_MAX)}
    </div>`;
}

/** Keep a value on its scale, so a bad saved value cannot fill past the bar. */
const onScale = (n: number, max: number) => Math.min(max, Math.max(1, Math.round(n) || 1));

/** Lowest and highest of the values, kept on the scale. */
const scaleRange = (values: number[], max: number): CategoryRange => {
  const known = values.map((n) => onScale(n, max));
  return { min: Math.min(...known), max: Math.max(...known) };
};

/** Range over one mood (min equals max) or the moods of several seasons; null if there are none. */
function moodRange(moods: Mood[]): MoodRange | null {
  if (!moods.length) return null;
  return {
    tone: scaleRange(moods.map((m) => m.tone), TONE_MAX),
    feeling: scaleRange(moods.map((m) => m.feeling), FEELING_MAX),
    depth: scaleRange(moods.map((m) => m.depth), DEPTH_MAX),
  };
}

/** The mood block for one mood or several seasons' moods; empty if there are none. */
function moodHtml(moods: Mood[]): string {
  const r = moodRange(moods);
  if (!r) return "";
  const values = [spanLabel(r.tone, TONE_LABELS), spanLabel(r.feeling, FEELING_LABELS), spanLabel(r.depth, DEPTH_LABELS)];
  return moodBlock(r, values.map(esc) as [string, string, string]);
}

/** An empty block of the same size, while the server rates a missing mood. */
const MOOD_PENDING = moodBlock(
  null,
  [`<span class="spinner" aria-hidden="true"></span>Rating…`, "…", "…"],
  ` id="mood-slot" aria-busy="true"`,
);

/** Put html in place of the pending block, or remove it when html is empty. */
function fillMoodSlot(seq: number, html: string): void {
  const slot = document.querySelector("#mood-slot");
  if (seq !== navSeq || !slot) return;
  if (html) slot.outerHTML = html;
  else slot.remove();
}

/** A section heading, with a "Back to top" button on the right. toTop: false for the first section, which is at the top. */
function sectionHead(title: string, toTop = true): string {
  return `
    <div class="section-head">
      <h2>${title}</h2>
      ${toTop ? `<button type="button" class="to-top" data-top>Back to top <span aria-hidden="true">↑</span></button>` : ""}
    </div>`;
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

/** Book categories as links to Browse with that category. */
const bookCategoryLinks = (ids: BookCategory[]) =>
  ids
    .map((id) => `<a href="/browse#${new URLSearchParams({ shelf: id })}">${esc(BOOK_CATEGORY_BY_ID.get(id)?.label ?? id)}</a>`)
    .join(" · ");

/** Details box: credits, book categories, themes, and the catalog link. */
function detailsBox(info: WorkInfo | undefined, themes: string[] = [], bookCategories: BookCategory[] = []): string {
  // Values are HTML: credits may contain links.
  const rows: [label: string, html: string][] = [
    ...(info?.credits ?? []).map((c): [string, string] => [c.label, (c.entries ?? []).map(creditHtml).join(", ")]),
    ...(bookCategories.length ? [["Categories", bookCategoryLinks(bookCategories)] as [string, string]] : []),
    ...(themes.length ? [["Themes", esc(themes.join(" · "))] as [string, string]] : []),
  ];
  return `
    <section class="card section" id="sec-details">
      ${sectionHead("Details")}
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

/** Delay before the loading message replaces the page; route() cancels it when the view is ready. */
const LOADING_DELAY_MS = 400;
let loadingTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Show a loading message if the view takes longer than LOADING_DELAY_MS. A fast
 * view (most saved titles) replaces the old page directly, which avoids a
 * flash and keeps the clicked poster on the page for the poster animation.
 */
function setLoading(message: string): void {
  clearTimeout(loadingTimer);
  const seq = navSeq;
  loadingTimer = setTimeout(() => {
    if (seq !== navSeq) return;
    app.innerHTML = `<p class="status"><span class="spinner" aria-hidden="true"></span>${esc(message)}</p>`;
  }, LOADING_DELAY_MS);
}

function errorHtml(err: unknown): string {
  return `<p class="status error">${esc((err as Error).message)}</p>`;
}

function hiddenNote(): string {
  const hiddenCount = CATEGORIES.length - visibleCategories(hidden).length;
  return hiddenCount ? `<p class="muted small">${hiddenCount} topic(s) hidden by your preferences.</p>` : "";
}

/**
 * True when a topic the user shows is over their concern limits: a level
 * above their highest, or a treatment they leave out. Browse marks the same
 * titles (see withinLimits).
 */
function overLimit(id: CategoryId, score: number | undefined, treatment?: TreatmentId | null): boolean {
  if (hidden.has(id)) return false;
  const max = limits.max[id];
  return (max !== undefined && (score ?? 0) > max) || (!!treatment && (limits.hide[id] ?? []).includes(treatment));
}

/** "Over your limit" under a rating row's level. */
const OVER_NOTE = `<span class="over-badge over-note">Over your limit</span>`;

function ratingsSection(report: Report): string {
  const rows = sectionRows((c) => {
    const r = report.categories[c.id];
    if (!r) return "";
    const over = overLimit(c.id, r.score, r.treatment);
    return `
      <tr${over ? ` class="over-limit"` : ""}>
        <th scope="row">${esc(c.label)}</th>
        <td class="score">${scoreBar(r.score)}<span class="score-label">${r.score} · ${esc(SCORE_LABELS[r.score])}</span>${treatmentChip(r.treatment)}${over ? OVER_NOTE : ""}</td>
        <td>${esc(r.notes)}</td>
      </tr>`;
  }, 3);
  return `
    <section class="card section" id="sec-ratings">
      ${sectionHead("Ratings", false)}
      <table class="ratings">
        <thead><tr><th>Topic</th><th>Level</th><th>Details</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="muted">All topics are hidden. Change them in <a href="/preferences">Preferences</a>.</td></tr>`}</tbody>
      </table>
      ${hiddenNote()}
    </section>`;
}

/** mood: the mood tiles, or the pending tiles. */
function summarySection(report: Report, mood: string): string {
  const positives = report.positives ?? [];
  return `
    <section class="card section" id="sec-summary">
      ${sectionHead("Summary")}
      <p class="summary">${esc(report.summary)}</p>
      ${mood}
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
const SEARCH_FILTER_KEY = "searchFilter";

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

/** One search result row. rated: the saved rating, for the badge and the composite bars. */
function resultItem(r: SearchResult, rated?: IndexEntry): string {
  const card = { id: r.id, kind: r.kind, title: r.title, years: r.year ? String(r.year) : null, imageUrl: r.imageUrl };
  return `
    <li>
      ${cardActions(rated ?? card, { small: true })}
      <a href="${pageHref(card)}">
        ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" alt="" width="110" height="165" loading="lazy" decoding="async" />` : `<span class="noimg" aria-hidden="true"></span>`}
        <span class="result-text">
          <strong>${esc(r.title)}</strong> ${r.year ? `<span class="muted">(${r.year})</span>` : ""}
          <span class="badge">${KIND_LABEL[r.kind]}</span>
          ${rated ? `<span class="badge rated">Rated</span>` : ""}
          ${r.released === false ? `<span class="badge upcoming">Not yet released</span>` : ""}
          ${r.detail ? `<span class="muted small block">${esc(r.detail)}</span>` : ""}
          ${rated ? `<span class="block result-bars">${miniComposites(rated)}</span>` : ""}
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

/** A rated title as a search result row. */
function ratedResult(t: IndexEntry): SearchResult {
  const year = Number(/\d{4}/.exec(t.years ?? "")?.[0]);
  return { id: t.id, kind: t.kind, title: t.title, year: year || null, detail: null, imageUrl: t.imageUrl, released: true };
}

interface SearchRow {
  r: SearchResult;
  rated?: IndexEntry;
}

/**
 * Search results grouped by type, with the type filter. Rated titles come
 * first in each group; pending adds a spinner below while the catalog search runs.
 */
function searchResultsHtml(rows: SearchRow[], warnings: string[], pending: boolean): string {
  const groups = SEARCH_KINDS.map((k) => ({ ...k, items: rows.filter((row) => row.r.kind === k.kind) })).filter(
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
            ${filterButton("all", "All", rows.length)}
            ${groups.map((g) => filterButton(g.kind, g.label, g.items.length)).join("")}
          </nav>
          ${groups
            .map(
              (g) => `
            <section class="result-group" data-kind="${g.kind}"${filter !== "all" && filter !== g.kind ? " hidden" : ""}>
              <h2>${esc(g.label)}</h2>
              <ul class="results">${g.items.map((row) => resultItem(row.r, row.rated)).join("")}</ul>
            </section>`,
            )
            .join("")}`
        : pending
          ? ""
          : `<p class="status">No matches. Try another spelling.</p>`
    }
    ${pending ? `<p class="status"><span class="spinner" aria-hidden="true"></span>Searching movies, TV shows, and books…</p>` : ""}`;
}

/** Rated titles to ask for: enough to fill the list and to filter them out of the catalog results. */
const RATED_LIMIT = 60;

/**
 * Search: titles that are already rated show at once (from the list of rated titles).
 * The slower catalog search then adds its results to the same list, without
 * the titles that are already shown.
 */
async function showSearch(q: string): Promise<string> {
  searchInput.value = q;
  setLoading(`Searching for "${q}"…`);
  const catalog = api.search(q);
  catalog.catch(() => {}); // Handled in afterRender; avoids an unhandled rejection meanwhile.
  const rated = await browse(new URLSearchParams({ q, limit: String(RATED_LIMIT) }).toString(), true).catch(() => null);
  const ratedRows: SearchRow[] = (rated?.items ?? []).map((t) => ({ r: ratedResult(t), rated: t }));
  const ratedIds = new Set(ratedRows.map((row) => row.r.id));
  const moreRated =
    rated && rated.total > RATED_LIMIT
      ? `<p><a href="/browse#${new URLSearchParams({ q })}">See all ${rated.total} rated matches →</a></p>`
      : "";

  const seq = navSeq;
  afterRender = () => {
    void catalog
      .then(({ results, warnings }) => {
        const added = results.filter((r) => !ratedIds.has(r.id)).map((r): SearchRow => ({ r }));
        return searchResultsHtml([...ratedRows, ...added], warnings, false) + moreRated;
      })
      // The rated titles stay; the error shows below them.
      .catch((err: unknown) => searchResultsHtml(ratedRows, [], false) + moreRated + errorHtml(err))
      .then((html) => {
        const box = document.querySelector<HTMLElement>("#search-results");
        if (seq !== navSeq || !box) return;
        box.innerHTML = html;
        box.removeAttribute("aria-busy");
      });
  };

  pageTitle = `Results for "${q}"`;
  return `
    <h1>Results for "${esc(q)}"</h1>
    <div id="search-results" aria-busy="true">${searchResultsHtml(ratedRows, [], true)}</div>`;
}

async function showReport(id: string): Promise<string> {
  const seq = navSeq;
  setLoading("Getting the rating. A new title can take up to a minute…");
  const res = await api.report(id);
  const seriesMatch = /^tmdb-tv-(\d+)-s\d+$/.exec(id);
  const back = seriesMatch ? `<p><a href="/tv/${seriesMatch[1]}">← All seasons</a></p>` : "";
  if (res.status === "unreleased") {
    pageTitle = res.title;
    return `${back}<h1>${esc(res.title)}</h1>
      <p class="status">Not yet released${res.releaseDate ? ` (expected ${esc(res.releaseDate)})` : ""}. Ratings are available after release.</p>`;
  }
  const r = res.report;
  setWatchId(r.id.startsWith("tmdb-") ? r.id : null, seq);
  const subtitle = r.kind === "tv-season" ? r.subtitle : (r.info?.subtitle ?? null);
  pageTitle = withYears(subtitle ? `${r.title} — ${subtitle}` : r.title, r.info);
  pageMeta = `Rated ${new Date(r.refreshedAt).toLocaleDateString()} by ${r.model} · confidence: ${r.confidence}`;
  // A result saved before moods existed: the server rates the mood now, and the tiles fill in.
  if (!hasMood(r)) {
    afterRender = () => {
      void api
        .mood(r.id)
        .then((m) => fillMoodSlot(seq, moodHtml([m])))
        .catch(() => fillMoodSlot(seq, ""));
    };
  }
  const mood = hasMood(r) ? moodHtml([r.mood]) : MOOD_PENDING;
  return `${back}
    ${titleHeader(
      r.title,
      subtitle,
      r.info,
      compositesHtml((id) => r.categories[id]?.score),
      r.id,
      Object.fromEntries(CATEGORIES.map((c) => [c.id, r.categories[c.id]?.score])),
    )}
    ${r.confidence === "low" ? `<p class="notice">The AI knows this work only a little. Details can be wrong.</p>` : ""}
    ${res.stale ? `<p class="notice">This result could not be refreshed just now. It may be out of date.</p>` : ""}
    ${jumpLinks([
      ["sec-ratings", "Ratings"],
      ["sec-summary", "Summary"],
      ...(hasSimilar() ? ([["sec-similar", "Similar"]] as [string, string][]) : []),
      ["sec-details", "Details"],
    ])}
    ${ratingsSection(r)}
    ${summarySection(r, mood)}
    ${similarSection()}
    ${detailsBox(r.info, r.themes, r.bookCategories)}`;
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
  const seq = navSeq;
  setLoading("Loading series…");
  const s: SeriesResponse = await api.series(tmdbId);
  setWatchId(`tmdb-tv-${tmdbId}`, seq);
  pageTitle = withYears(s.title, s.info);
  const agg = s.aggregate;
  const aggRows = sectionRows((c) => {
    const range = agg.categories[c.id];
    if (!range) return "";
    const text = range.min === range.max ? `${range.max}` : `${range.min}–${range.max}`;
    // Seasons over the limit: the highest level counts (the series has no treatments).
    const over = overLimit(c.id, range.max);
    return `<tr${over ? ` class="over-limit"` : ""}><th scope="row">${esc(c.label)}</th><td class="score">${rangeBar(range)}<span class="score-label">${text}</span>${over ? OVER_NOTE : ""}</td></tr>`;
  }, 2);

  const seasonsList = s.seasons
    .map(
      (season) => `
        <li>
          <span><strong>${esc(season.name)}</strong> <span class="muted small">${season.episodeCount} episodes${season.airDate ? ` · ${esc(season.airDate.slice(0, 4))}` : ""}</span></span>
          ${
            season.report
              ? `<a class="button" href="${titlePath({ id: season.reportId, title: s.title, years: season.airDate })}">View rating</a>`
              : season.released
                ? `<a class="button primary" href="${titlePath({ id: season.reportId, title: s.title, years: season.airDate })}">Rate this season</a>`
                : `<span class="muted small">Not yet released</span>`
          }
        </li>`,
    )
    .join("");

  // Mood range across the rated seasons. Seasons saved before moods existed get one from the server first.
  const ratedSeasons = s.seasons.filter((season) => season.report);
  const knownMoods = ratedSeasons.flatMap((season) => (season.report && hasMood(season.report) ? [season.report.mood] : []));
  const missingMoods = ratedSeasons.filter((season) => !(season.report && hasMood(season.report))).map((season) => season.reportId);
  const seriesMood = (moods: Mood[]) => moodHtml(moods);
  if (missingMoods.length) {
    afterRender = () => {
      void Promise.allSettled(missingMoods.map((id) => api.mood(id))).then((results) => {
        const added = results.flatMap((res) => (res.status === "fulfilled" ? [res.value] : []));
        fillMoodSlot(seq, seriesMood([...knownMoods, ...added]));
      });
    };
  }
  const mood = missingMoods.length ? MOOD_PENDING : seriesMood(knownMoods);
  // The Summary section holds the overview and the mood tiles; skip it when it has neither.
  const hasSummary = Boolean(s.overview || mood);

  const sections: [string, string][] = [
    ["sec-ratings", "Ratings"],
    ["sec-seasons", "Seasons"],
    ...(hasSummary ? ([["sec-summary", "Summary"]] as [string, string][]) : []),
    ...(hasSimilar() ? ([["sec-similar", "Similar"]] as [string, string][]) : []),
    ["sec-details", "Details"],
  ];

  return `
    ${titleHeader(
      s.title,
      null,
      s.info,
      compositesHtml((id) => agg.categories[id]?.max, { upTo: true }),
      s.id,
      Object.fromEntries(CATEGORIES.map((c) => [c.id, agg.categories[c.id]?.max])),
    )}
    ${jumpLinks(sections)}
    <section class="card section" id="sec-ratings">
      ${sectionHead("Ratings for the whole series", false)}
      ${
        agg.ratedSeasons
          ? `${agg.partial ? `<p class="notice">Partial: based on ${agg.ratedSeasons} of ${agg.releasedSeasons} released seasons. Rate more seasons below to complete it.</p>` : ""}
             <table class="ratings"><tbody>${aggRows}</tbody></table>
             ${hiddenNote()}`
          : `<p class="muted">No seasons rated yet. Select a season below.</p>`
      }
    </section>
    <section class="card section" id="sec-seasons">
      ${sectionHead("Seasons")}
      <ul class="seasons">${seasonsList}</ul>
    </section>
    ${
      hasSummary
        ? `<section class="card section" id="sec-summary">
            ${sectionHead("Summary")}
            ${s.overview ? `<p class="summary">${esc(s.overview)}</p>` : ""}
            ${mood}
          </section>`
        : ""
    }
    ${similarSection()}
    ${detailsBox(s.info, seriesThemes(s))}`;
}

const RECENT_HEADINGS: Record<RecentItem["kind"], string> = { movie: "Movies", tv: "TV shows", book: "Books" };

/** Page for a title: the series page for TV, the report page otherwise. */
function pageHref(item: Pick<RecentItem, "id" | "kind" | "title" | "years">): string {
  return titlePath(item);
}

// Feather icons (MIT): bookmark and eye-off.
const ACTION_ICONS = {
  list: MARK_ICONS.list,
  hide: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22",
};

function watchlistButton(id: string, title: string): string {
  const on = id in watchlist;
  return `
    <button type="button" class="card-action" data-card-action="list" aria-pressed="${on}" aria-label="${esc(`${title}: on my watchlist`)}" title="${on ? "Remove from watchlist" : "Add to watchlist"}">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${ACTION_ICONS.list}" /></svg>
    </button>`;
}

/**
 * Buttons over a poster: the watchlist toggle, and "Not interested" for
 * recommended titles. small: for the search result thumbnails.
 */
function cardActions(item: Pick<RecentItem, "id" | "kind" | "title" | "years" | "imageUrl">, opts: { notInterested?: boolean; small?: boolean } = {}): string {
  const id = markId(item.id);
  const title: MarkTitle = { kind: item.kind, title: item.title, years: item.years, imageUrl: item.imageUrl };
  return `
    <div class="card-actions${opts.small ? " small" : ""}" data-id="${esc(id)}" data-title="${esc(JSON.stringify(title))}">
      ${watchlistButton(id, item.title)}
      ${
        opts.notInterested
          ? `<button type="button" class="card-action" data-card-action="hide" aria-label="${esc(`Not interested in ${item.title}`)}" title="Not interested">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${ACTION_ICONS.hide}" /></svg>
            </button>`
          : ""
      }
    </div>`;
}

/** Search results have small posters; the watchlist card gets the larger size. */
function largerPoster(url: string | null): string | null {
  return url?.replace("/t/p/w92/", "/t/p/w185/").replace(/-S\.jpg$/, "-M.jpg") ?? null;
}

/** extra: HTML between the poster and the title (the composite bars). notInterested: recommended titles only. */
/**
 * Poster sizes for a grid card, which grows past 110px to fill its row (see
 * .cards.grid): TMDB w185 and w342, Open Library M and L. Empty for other URLs.
 */
function gridSrcset(url: string): string {
  if (url.includes("/t/p/w185/")) return `${url} 185w, ${url.replace("/t/p/w185/", "/t/p/w342/")} 342w`;
  if (/-M\.jpg$/.test(url)) return `${url} 180w, ${url.replace(/-M\.jpg$/, "-L.jpg")} 500w`;
  return "";
}

/** About the widest a grid card gets at each screen width: 2 columns on phones, 3 on small tablets. */
const GRID_SIZES = "(max-width: 520px) 50vw, (max-width: 760px) 33vw, 160px";

/** grid: a card in a .cards.grid list, which loads a larger poster when it needs one. */
function cardHtml(item: RecentItem, showKind: boolean, extra = "", opts: { notInterested?: boolean; className?: string; grid?: boolean } = {}): string {
  const srcset = opts.grid && item.imageUrl ? gridSrcset(item.imageUrl) : "";
  const sizes = srcset ? ` srcset="${esc(srcset)}" sizes="${GRID_SIZES}"` : "";
  return `
    <li${opts.className ? ` class="${opts.className}"` : ""}>
      ${cardActions(item, opts)}
      <a href="${pageHref(item)}">
        ${item.imageUrl ? `<img src="${esc(item.imageUrl)}"${sizes} alt="" width="110" height="165" loading="lazy" decoding="async" />` : `<span class="noimg" aria-hidden="true"></span>`}
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

/** The user's watchlist, most recently added first. Empty when the list is empty. index: rated titles, for the bars. */
/** Watchlist titles shown on the home page; the rest are on the watchlist page. */
const WATCHLIST_HOME = 8;

/**
 * Watchlist cards, most recently added first. index: rated titles, for the
 * bars and the streaming services. mine: only titles on the user's services.
 */
function watchlistCards(index: Map<string, IndexEntry> | null, limit = Infinity, grid = false, mine = false): string[] {
  return Object.entries(watchlist)
    .filter(([id]) => !mine || onMyServices(index?.get(id)?.providers, hiddenProviders))
    .sort((a, b) => b[1].addedAt.localeCompare(a[1].addedAt))
    .slice(0, limit)
    .map(([id, e]) => {
      const rated = index?.get(id);
      const item: RecentItem = { id, ...e, scores: rated?.scores ?? {} };
      return cardHtml(item, true, rated ? miniComposites(item) : "", { grid });
    });
}

/** The home page row: the newest few, with "Show all" when there are more. Empty when the list is empty. */
function watchlistHtml(index: Map<string, IndexEntry> | null): string {
  const total = Object.keys(watchlist).length;
  if (!total) return "";
  return `
    <section class="recent watchlist">
      <div class="row-head">
        <h2>My watchlist</h2>
        ${total > WATCHLIST_HOME ? `<a href="/watchlist">Show all ${total} →</a>` : ""}
      </div>
      <ul class="cards">${watchlistCards(index, WATCHLIST_HOME).join("")}</ul>
    </section>`;
}

/** Rated titles for the watchlist page, for the bars and the services filter. Null when they do not load. */
let watchlistIndex: Map<string, IndexEntry> | null = null;
/** The watchlist page shows only titles on the user's services (streaming=mine in the URL). */
let watchlistMine = false;

/** Count line of the watchlist page. */
function watchlistCount(): string {
  const total = Object.keys(watchlist).length;
  if (!total) return "Your watchlist is empty.";
  const titles = (n: number) => `${n} title${n === 1 ? "" : "s"}`;
  if (!watchlistMine) return `${titles(total)}, most recently added first.`;
  const shown = Object.keys(watchlist).filter((id) => onMyServices(watchlistIndex?.get(id)?.providers, hiddenProviders)).length;
  return shown
    ? `${shown} of ${titles(total)} stream on my services, most recently added first.`
    : `None of the ${titles(total)} stream on my services.`;
}

/** Draw the watchlist page's count and cards again, e.g. after the services filter changes. */
function renderWatchlistGrid(): void {
  const grid = document.querySelector("#watchlist-grid");
  if (!grid) return;
  grid.innerHTML = watchlistCards(watchlistIndex, Infinity, true, watchlistMine).join("");
  document.querySelector("#watchlist-count")!.textContent = watchlistCount();
}

/** Every watchlist title, most recently added first. params: streaming=mine shows only titles on the user's services. */
async function showWatchlist(params: URLSearchParams): Promise<string> {
  searchInput.value = "";
  pageTitle = "My watchlist";
  const total = Object.keys(watchlist).length;
  watchlistIndex = total ? await titlesById().catch(() => null) : null;
  // Without the rated titles, no title has services to filter on.
  watchlistMine = params.get("streaming") === "mine" && watchlistIndex !== null;
  return `
    <h1>My watchlist</h1>
    ${
      total
        ? `${
            watchlistIndex
              ? `<fieldset class="kind-toggles watchlist-filters"><legend>Streaming</legend>
                  <label class="chip-check" title="Rated movies and TV series that stream on a service checked in My services"><input type="checkbox" name="streaming" value="mine"${watchlistMine ? " checked" : ""} />On my services</label>
                </fieldset>`
              : ""
          }
           <p class="muted" id="watchlist-count">${esc(watchlistCount())}</p>
           <ul class="cards grid" id="watchlist-grid">${watchlistCards(watchlistIndex, Infinity, true, watchlistMine).join("")}</ul>`
        : `<p class="muted">Your watchlist is empty. Select the bookmark on a title's page to add it.</p>`
    }`;
}

app.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.name !== "streaming" || !box.closest(".watchlist-filters")) return;
  watchlistMine = box.checked;
  history.replaceState({ scrollY: 0, depth } satisfies PageState, "", `/watchlist${watchlistMine ? "#streaming=mine" : ""}`);
  renderWatchlistGrid();
});

/** Recommendations on the home page; the rest are on the recommendations page. */
const RECOMMEND_HOME = 12;
/** Most titles on the recommendations page. */
const RECOMMEND_PAGE = 100;

/**
 * Rated titles picked from the user's thumbs (see recommend), not ones on the
 * watchlist, best match first. Empty without a thumbs up or the rated titles.
 */
function recommendations(index: Map<string, IndexEntry> | null, model: TasteModel | null, limit: number): IndexEntry[] {
  if (!index) return [];
  return recommend(titleList(index), thumbs, {
    exclude: new Set(Object.keys(watchlist)),
    notInterested,
    categories: visibleCategories(hidden).map((c) => c.id),
    limit,
    model,
  });
}

/** The home page row, with "Show more" when there are more. Empty with no recommendations. */
function recommendedHtml(index: Map<string, IndexEntry> | null, model: TasteModel | null): string {
  const picks = recommendations(index, model, RECOMMEND_HOME + 1);
  if (!picks.length) return "";
  return `
    <section class="recent recommended">
      <div class="row-head">
        <h2 class="with-info">
          Recommended for you
          <span class="info-wrap">
            <button type="button" class="info-icon" aria-label="About recommendations" aria-describedby="recommend-info">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
            </button>
            <span class="info-tip" id="recommend-info" role="tooltip">Recommendations are automatically generated based on titles you liked/disliked or marked "Not interested" and never leave the browser.</span>
          </span>
        </h2>
        ${picks.length > RECOMMEND_HOME ? `<a href="/recommended">Show more recommendations →</a>` : ""}
      </div>
      <ul class="cards">${picks
        .slice(0, RECOMMEND_HOME)
        .map((t) => cardHtml(t, true, miniComposites(t), { notInterested: true }))
        .join("")}</ul>
    </section>`;
}

/** Count line of the recommendations page, from the cards on it. */
function recommendedCount(n: number): string {
  return n ? `${n} title${n === 1 ? "" : "s"} picked from your thumbs up and down, best match first.` : "No more recommendations.";
}

/** Up to RECOMMEND_PAGE recommendations, best match first. */
async function showRecommended(): Promise<string> {
  searchInput.value = "";
  pageTitle = "Recommended for you";
  const index = await titlesById().catch(() => null);
  const model = index ? await tasteModelFor(index, thumbs, notInterested) : null;
  const picks = recommendations(index, model, RECOMMEND_PAGE);
  return `
    <h1>Recommended for you</h1>
    ${
      picks.length
        ? `<p class="muted" id="recommended-count">${esc(recommendedCount(picks.length))}</p>
           <ul class="cards grid" id="recommended-grid">${picks.map((t) => cardHtml(t, true, miniComposites(t), { notInterested: true, grid: true })).join("")}</ul>`
        : `<p class="muted">No recommendations yet. Give a title a thumbs up on its page to get some.</p>`
    }`;
}

/** Rated titles from the last home page render, to draw its watchlist and recommendations again. */
let homeIndex: Map<string, IndexEntry> | null = null;

/** The home page rows that depend on the user's choices, after the taste model for the current marks is ready. */
async function personalHtml(): Promise<string> {
  const model = homeIndex ? await tasteModelFor(homeIndex, thumbs, notInterested) : null;
  return `<div id="home-personal">${watchlistHtml(homeIndex)}${recommendedHtml(homeIndex, model)}</div>`;
}

/** Draw every card's watchlist toggle for this title again, with the current state. */
function refreshListButtons(id: string): void {
  for (const other of document.querySelectorAll<HTMLButtonElement>(`.card-actions[data-id="${CSS.escape(id)}"] [data-card-action="list"]`)) {
    const title = JSON.parse(other.closest<HTMLElement>(".card-actions")!.dataset.title!) as MarkTitle;
    other.outerHTML = watchlistButton(id, title.title);
  }
}

function cardAction(button: HTMLButtonElement): void {
  const box = button.closest<HTMLElement>(".card-actions")!;
  const id = box.dataset.id!;
  const removed = button.dataset.cardAction === "list" && id in watchlist;
  if (button.dataset.cardAction === "list") {
    if (removed) delete watchlist[id];
    else {
      const title = JSON.parse(box.dataset.title!) as MarkTitle;
      watchlist[id] = { ...title, imageUrl: largerPoster(title.imageUrl), addedAt: new Date().toISOString() };
    }
    saveWatchlist(watchlist);
  } else {
    notInterested[id] = new Date().toISOString();
    saveNotInterested(notInterested);
  }

  // Every card of this title on the page shows the new state, and so does the
  // title page's own button (the rail card is on the title page).
  refreshListButtons(id);
  const marks = document.querySelector<HTMLElement>("#marks");
  if (marks?.dataset.id === id) marks.outerHTML = marksHtml(id, JSON.parse(marks.dataset.title!) as MarkTitle);

  // Watchlist page: a removed title leaves the grid.
  const grid = document.querySelector("#watchlist-grid");
  if (grid && removed) {
    box.closest("li")?.remove();
    document.querySelector("#watchlist-count")!.textContent = watchlistCount();
  }

  // Recommendations page: a title marked "Not interested" leaves the grid.
  const recommendedGrid = document.querySelector("#recommended-grid");
  if (recommendedGrid && button.dataset.cardAction === "hide") {
    box.closest("li")?.remove();
    document.querySelector("#recommended-count")!.textContent = recommendedCount(recommendedGrid.children.length);
  }

  // Home page: the watchlist row and the recommendations change.
  const personal = document.querySelector("#home-personal");
  if (personal) {
    const section = box.closest("#home-personal section");
    const kind = section?.classList.contains("recommended") ? "recommended" : section ? "watchlist" : null;
    const position = kind ? [...section!.querySelectorAll(".card-actions")].indexOf(box) : -1;
    void personalHtml().then((html) => {
      // The user may have left the home page while the titles were scored.
      const now = document.querySelector("#home-personal");
      if (!now) return;
      now.outerHTML = html;
      if (kind) {
        // The card may have left its row: focus the card now in its place.
        const cards = document.querySelectorAll<HTMLElement>(`#home-personal .${kind} .cards > li`);
        const card = cards[position] ?? cards[cards.length - 1];
        card?.querySelector<HTMLElement>(`[data-card-action="${button.dataset.cardAction}"]`)?.focus({ preventScroll: true }) ??
          card?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
      }
    });
  } else {
    // The button was drawn again: put focus back on it.
    document.querySelector<HTMLElement>(`.card-actions[data-id="${CSS.escape(id)}"] [data-card-action="list"]`)?.focus({ preventScroll: true });
  }
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
          <a href="/browse#kind=${kind}">Browse all ${RECENT_HEADINGS[kind].toLowerCase()} →</a>
        </div>
        <ul class="cards">${recent[kind].map((item) => cardHtml(item, false, miniComposites(item))).join("")}</ul>
      </section>`,
    );
  return rows.length
    ? `<section class="recent"><h2>Recently added</h2>${rows.join("")}<p><a href="/browse">Browse all rated titles →</a></p></section>`
    : "";
}

async function showHome(): Promise<string> {
  searchInput.value = "";
  // These lists are a bonus: if one fails to load, show the home page without it.
  const [trending, recent, index] = await Promise.all([
    api.trending().catch(() => []),
    api.recent().catch(() => null),
    // The rated titles give watchlist cards their bars and the recommendations. Loaded only when needed.
    // Scoring for the recommendations starts when they arrive, while the other lists load.
    Object.keys(watchlist).length || Object.values(thumbs).includes("up")
      ? titlesById().then((index) => {
          if (index) void tasteModelFor(index, thumbs, notInterested);
          return index;
        })
      : null,
  ]);
  homeIndex = index;
  const personal = await personalHtml();
  return `
    <section class="hero">
      <h1>Know what is in it before your kids see it.</h1>
      <p>AI-generated summaries of movies, TV shows, and books for content that parents may want to know about.</p>
    </section>
    ${personal}
    ${trendingHtml(trending)}
    ${recent ? recentHtml(recent) : ""}`;
}

// ---------- Browse ----------

// The filters live in the URL (/browse#kind=movie&max.violence=2...), so a
// filtered list can be bookmarked or shared. The browser filters the list of
// rated titles with that query string; see src/client/titles.ts.


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

/** Over the saved concern limits, for marking cards while the page shows those titles. Null while the limits apply. */
type OverCheck = ((t: IndexEntry) => boolean) | null;

function overLimitsCheck(params: URLSearchParams): OverCheck {
  const keys = limitParams(limits, hidden);
  if (params.get("limits") !== "off" || !keys.length) return null;
  const f = parseBrowseQuery(new URLSearchParams(keys));
  return (t) => !withinLimits(t, f);
}

function browseCards(items: IndexEntry[], over: OverCheck = null): string {
  return items
    .map((t) =>
      over?.(t)
        ? cardHtml(t, true, `${miniComposites(t)}<span class="over-badge">Over your limits</span>`, { className: "over-limits", grid: true })
        : cardHtml(t, true, miniComposites(t), { grid: true }),
    )
    .join("");
}

/** One row of level chips per mood scale. Checked levels pass; none checked passes any level. */
function moodFilters(params: URLSearchParams): string {
  return MOOD_SCALES.map(({ id, label, labels }) => {
    const set = new Set(params.getAll(id).flatMap((v) => v.split(",")));
    return `
      <div class="mood-filter">
        <span class="mood-filter-label">${esc(label)}</span>
        <span class="tag-chips">${Object.entries(labels)
          .map(
            ([n, name]) =>
              `<label class="chip-check"><input type="checkbox" name="${id}" value="${n}"${set.has(n) ? " checked" : ""} />${esc(name)}</label>`,
          )
          .join("")}</span>
      </div>`;
  }).join("");
}

/** Number of mood scales with levels set in the query. */
const moodFilterCount = (params: URLSearchParams) => MOOD_SCALES.filter(({ id }) => params.has(id)).length;

/** "(2 selected)" for the Theme tags heading; empty when none. */
const tagCount = (n: number) => (n ? `(${n} selected)` : "");

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

/** "(2 selected)" for the Book categories heading; empty when none. */
const shelfCount = (params: URLSearchParams) => tagCount(params.getAll("shelf").length);

/** Book category chips by group: categories in the current results and selected ones, in list order. */
function bookChips(res: BrowseResponse, selected: Set<string>): string {
  const counts = new Map(res.bookCategories.map((c) => [c.id as string, c.count]));
  const shown = BOOK_CATEGORIES.filter((c) => counts.has(c.id) || selected.has(c.id));
  if (!shown.length) return `<span class="muted small">No book categories in these results.</span>`;
  return BOOK_CATEGORY_GROUPS.flatMap((g) => {
    const chips = shown.filter((c) => c.group === g.id);
    if (!chips.length) return [];
    return [
      `<div class="mood-filter">
        <span class="mood-filter-label">${esc(g.label)}</span>
        <span class="tag-chips">${chips
          .map(
            (c) =>
              `<label class="chip-check" title="${esc(c.description)}"><input type="checkbox" name="shelf" value="${c.id}"${selected.has(c.id) ? " checked" : ""} />${esc(c.label)} <span class="count">${counts.get(c.id) ?? 0}</span></label>`,
          )
          .join("")}</span>
      </div>`,
    ];
  }).join("");
}

/** "24 titles" above the list; empty when nothing matches (the list says so). */
const countText = (res: BrowseResponse) => (res.total ? `${res.total} title${res.total === 1 ? "" : "s"}` : "");

function browseResultsHtml(res: BrowseResponse, over: OverCheck): string {
  if (!res.total) return `<p class="status">No titles match these filters.</p>`;
  return `
    <ul class="cards grid">${browseCards(res.items, over)}</ul>
    ${res.items.length < res.total ? `<p><button type="button" class="button" data-more="${res.items.length}">Show more</button></p>` : ""}`;
}

/** The query string for the current form values. Empty values are left out. */
function browseParams(form: HTMLFormElement): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    if (typeof value === "string" && value.trim() && !(key === "sort" && value === "added")) params.append(key, value.trim());
  }
  if (params.get("sort") !== "random") params.delete("seed");
  // Every type on is the same as no type filter: keep the URL short.
  if (params.getAll("kind").length === SEARCH_KINDS.length) params.delete("kind");
  return params;
}

/**
 * The browse request for the page's filters, with the saved concern limits
 * unless the page shows titles over them (limits=off). "On my services" also
 * needs the services the user does not have. Neither goes in the page URL.
 */
function browseQuery(params: URLSearchParams, withLimits = params.get("limits") !== "off"): string {
  const query = new URLSearchParams(params);
  query.delete("limits");
  if (withLimits) for (const [key, value] of limitParams(limits, hidden)) query.append(key, value);
  if (query.get("streaming") === "mine" && hiddenProviders.size) query.set("hideService", [...hiddenProviders].join(","));
  return query.toString();
}

/** Results for the page, and how many titles the concern limits leave out (0 with no limits). */
async function browseCounted(params: URLSearchParams, fresh = false): Promise<{ res: BrowseResponse; over: number }> {
  if (!limitParams(limits, hidden).length) return { res: await browse(browseQuery(params, false), fresh), over: 0 };
  const res = await browse(browseQuery(params), fresh);
  // The other count, with limits if the page has none and the other way round. Only its total is used.
  const off = params.get("limits") === "off";
  const other = await browse(`${browseQuery(params, off)}&limit=1`);
  return { res, over: Math.abs(res.total - other.total) };
}

/** Label of the over-limits toggle. It stays while on, even at 0, so the user can turn it off. */
const overText = (n: number, on: boolean) => `${on ? "Showing" : "Show"} ${n} title${n === 1 ? "" : "s"} over my concern limits`;

async function showBrowse(query: string): Promise<string> {
  searchInput.value = "";
  setLoading("Loading titles…");
  const params = new URLSearchParams(query);
  // Old links can carry limits; the saved ones on the Preferences page apply instead.
  for (const key of [...params.keys()]) if (/^(max|hide)\./.test(key)) params.delete(key);
  const { res, over } = await browseCounted(params, true);
  const off = params.get("limits") === "off";
  const kinds = new Set(params.getAll("kind").flatMap((v) => v.split(",")));
  const sort = params.get("sort") ?? "added";
  const selectedTags = new Set(params.getAll("tag").filter((t) => (THEME_TAGS as readonly string[]).includes(t)));
  const selectedShelf = new Set(params.getAll("shelf").filter((id) => BOOK_CATEGORY_BY_ID.has(id)));
  const moods = moodFilterCount(params);
  pageTitle = "Browse";

  return `
    <div class="row-head browse-head">
      <h1>Browse rated titles</h1>
      <button type="button" data-browse-clear>Clear filters</button>
    </div>
    <form id="browse-form" class="browse-form">
      <div class="browse-row">
        <fieldset class="kind-toggles"><legend>Show</legend>
          ${SEARCH_KINDS.map(
            (k) =>
              `<label class="chip-check"><input type="checkbox" name="kind" value="${k.kind}"${!kinds.size || kinds.has(k.kind) ? " checked" : ""} />${esc(k.label)}</label>`,
          ).join("")}
        </fieldset>
        <fieldset class="kind-toggles"><legend>Streaming</legend>
          <label class="chip-check" title="Movies and TV series that stream on a service checked in My services"><input type="checkbox" name="streaming" value="mine"${params.get("streaming") === "mine" ? " checked" : ""} />On my services</label>
        </fieldset>
        <label><span>Title</span><input type="search" name="q" value="${esc(params.get("q") ?? "")}" placeholder="Title contains" /></label>
      </div>
      <details class="topic-filters"${selectedTags.size ? " open" : ""}>
        <summary>Theme tags <span class="count" id="tag-count">${tagCount(selectedTags.size)}</span></summary>
        <div class="tag-chips" id="browse-tags" aria-label="Theme tags">${tagChips(res, selectedTags)}</div>
      </details>
      <details class="topic-filters"${selectedShelf.size ? " open" : ""}>
        <summary>Book categories <span class="count" id="shelf-count">${shelfCount(params)}</span></summary>
        <div id="browse-shelf" aria-label="Book categories">${bookChips(res, selectedShelf)}</div>
      </details>
      <details class="topic-filters"${moods ? " open" : ""}>
        <summary>Mood <span class="count" id="mood-count">${moods ? `(${moods} set)` : ""}</span></summary>
        ${moodFilters(params)}
      </details>
      <div class="row-head results-head">
        <div class="results-count">
          <p class="muted" id="browse-count">${countText(res)}</p>
          <label class="chip-check" id="over-toggle"${over || off ? "" : " hidden"}><input type="checkbox" name="limits" value="off"${off ? " checked" : ""} /><span id="over-text">${overText(over, off)}</span></label>
        </div>
        <div class="sort-by">
          <input type="hidden" name="seed" value="${sort === "random" ? esc(params.get("seed") ?? "") : ""}" />
          <button type="button" data-browse-shuffle${sort === "random" ? "" : " hidden"}>Randomize</button>
          <label><span>Sort by</span>
            <select name="sort">
              ${[["added", "Recently added"], ["title", "Title"], ["year", "Year (newest)"], ["score", "User score (highest)"], ["random", "Random"]]
                .map(([v, label]) => `<option value="${v}"${v === sort ? " selected" : ""}>${label}</option>`)
                .join("")}
            </select>
          </label>
        </div>
      </div>
    </form>
    <div id="browse-results">${browseResultsHtml(res, overLimitsCheck(params))}</div>`;
}

// Each filter change gets a number, so a slow response cannot overwrite a newer one.
let browseSeq = 0;

/** Apply the form to the URL and reload the results, without rebuilding the form. */
async function updateBrowse(form: HTMLFormElement): Promise<void> {
  const seq = ++browseSeq;
  const params = browseParams(form);
  history.replaceState({ scrollY: 0, depth } satisfies PageState, "", `/browse${params.size ? `#${params}` : ""}`);
  document.querySelector("#tag-count")!.textContent = tagCount(params.getAll("tag").length);
  document.querySelector("#shelf-count")!.textContent = shelfCount(params);
  const moods = moodFilterCount(params);
  document.querySelector("#mood-count")!.textContent = moods ? `(${moods} set)` : "";
  const results = document.querySelector<HTMLElement>("#browse-results")!;
  results.setAttribute("aria-busy", "true");
  try {
    const { res, over } = await browseCounted(params);
    if (seq !== browseSeq) return;
    document.querySelector<HTMLElement>("#over-toggle")!.hidden = !over && params.get("limits") !== "off";
    document.querySelector("#over-text")!.textContent = overText(over, params.get("limits") === "off");
    results.innerHTML = browseResultsHtml(res, overLimitsCheck(params));
    document.querySelector("#browse-count")!.textContent = countText(res);
    watchMore();
    document.querySelector("#browse-tags")!.innerHTML = tagChips(res, new Set(params.getAll("tag")));
    document.querySelector("#browse-shelf")!.innerHTML = bookChips(res, new Set(params.getAll("shelf")));
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
    const res = await browse(browseQuery(params));
    document.querySelector("#browse-results .cards")?.insertAdjacentHTML("beforeend", browseCards(res.items, overLimitsCheck(params)));
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

/** A seed for sort=random (see src/shared/browse.ts). */
const newSeed = () => String(Math.floor(Math.random() * 2 ** 31));

app.addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  const form = target.closest<HTMLFormElement>("#browse-form");
  if (!form) return;
  // Keep at least one type on; with none, the list would always be empty.
  if (target.name === "kind" && !form.querySelector("input[name=kind]:checked")) {
    target.checked = true;
    return;
  }
  if (target.name === "sort") {
    const random = target.value === "random";
    form.querySelector<HTMLElement>("button[data-browse-shuffle]")!.hidden = !random;
    const seed = form.querySelector<HTMLInputElement>("input[name=seed]")!;
    if (random && !seed.value) seed.value = newSeed();
  }
  if (target.name !== "q") void updateBrowse(form);
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

/** Title id for the streaming line on the current page (movies and TV), or null. Views set it with setWatchId. */
let watchId: string | null = null;

/** seq: the view's navSeq. A view that the user already left changes nothing. */
function setWatchId(id: string | null, seq = navSeq): void {
  if (seq !== navSeq) return;
  watchId = id;
  pageProviders = id ? cachedWatch(id) : null;
}

/** Line for the site footer about the current page (e.g. the rating date). Views set it. */
let pageMeta = "";
const pageMetaEl = document.querySelector<HTMLElement>("#page-meta")!;
const footerEl = document.querySelector<HTMLElement>(".site-footer")!;

/** Name of the current page, added to the site name in the browser tab. Views set it. */
let pageTitle = "";
const SITE_TITLE = document.title;

/** "Back to the Future (1985)": the title with its years, when known. */
function withYears(title: string, info: WorkInfo | undefined): string {
  return info?.years ? `${title} (${info.years})` : title;
}

// ---------- URLs ----------

// Pages have real paths (see src/shared/paths.ts). In this file, a page's
// route is shorter, with its state after "?": "/r/<report id>" for a movie,
// book, or TV season, "/tv/<tmdb id>" for a series, "/browse?kind=movie". In
// the URL, the state goes after "#" (/browse#kind=movie), so the browser never
// sends it to the server.

/** The route of a URL's path and fragment: "/movie/603/<slug>" → "/r/tmdb-movie-603", "#kind=movie" → "?kind=movie". Null when it is not an app page. */
function routeOf(pathname: string, fragment: string): string | null {
  const id = pathId(pathname);
  const path = id ? (/^tmdb-tv-\d+$/.test(id) ? `/tv/${id.slice(8)}` : `/r/${id}`) : pathname;
  if (!id && !APP_PAGE.test(path)) return null;
  const state = fragment.replace(/^#/, "");
  return state ? `${path}?${state}` : path;
}

/** The app pages other than titles. public/sw.js has the same list in its APP_PAGE. */
const APP_PAGE = /^\/(?:browse|watchlist|recommended|preferences|search)?$/;

/** The route of a link to an app page on this site, or null (privacy.html, other sites, files). */
function routeOfHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, location.href);
  } catch {
    return null;
  }
  return url.origin === location.origin ? routeOf(url.pathname, url.hash) : null;
}

/** Open an app page, with a new history entry. */
function navigate(url: string): void {
  history.pushState(null, "", url);
  void route();
}

async function route(): Promise<void> {
  const seq = ++navSeq;
  // Read before the view replaces the page: the loading message makes the
  // page short, and the browser then moves the scroll position.
  const saved = history.state as PageState | null;
  trackDepth(saved);
  routing = true;
  closeSuggestions();
  pageMeta = "";
  pageTitle = "";
  afterRender = null;
  setWatchId(null);
  const hash = routeOf(location.pathname, location.hash) ?? "/";
  let html: string;
  try {
    let m: RegExpExecArray | null;
    if ((m = /^\/search\?q=(.+)$/.exec(hash))) html = await showSearch(decodeURIComponent(m[1]!));
    else if ((m = /^\/r\/([\w-]+)$/.exec(hash))) html = await showReport(m[1]!);
    else if ((m = /^\/tv\/(\d+)$/.exec(hash))) html = await showSeries(m[1]!);
    else if ((m = /^\/browse(?:\?(.*))?$/.exec(hash))) html = await showBrowse(m[1] ?? "");
    else if ((m = /^\/watchlist(?:\?(.*))?$/.exec(hash))) html = await showWatchlist(new URLSearchParams(m[1] ?? ""));
    else if (hash === "/recommended") html = await showRecommended();
    else if (hash === "/preferences") html = showPreferences();
    else html = await showHome();
  } catch (err) {
    html = errorHtml(err);
  }
  if (seq !== navSeq) return;
  clearTimeout(loadingTimer);
  const fromHash = currentHash;
  currentHash = hash;

  const render = async (): Promise<void> => {
    app.innerHTML = html;
    fillRailJumps();
    placeTitleText();
    updateRail();
    updateJumps();
    watchMore();
    // The cast undoes TypeScript's narrowing to null: the awaited view above may have set it.
    const after = afterRender as (() => void) | null;
    afterRender = null;
    after?.();
    if (watchId) {
      loadWatch(watchId, seq);
      loadSimilar(watchId, seq);
    }
    void refreshFit();
    pageMetaEl.textContent = pageMeta;
    pageMetaEl.hidden = !pageMeta;
    footerEl.hidden = false;
    document.title = pageTitle ? `${SITE_TITLE} - ${pageTitle}` : SITE_TITLE;
    await restoreScroll(saved, seq);
  };
  await morphPoster(fromHash, hash, render);
}

// ---------- Poster animation ----------

// Opening a title from a poster card moves the poster to its place on the
// title page, and Back moves it to the card again. It uses the View
// Transitions API; without it, or with reduced motion, pages change at once.

/** Route of the page on screen, e.g. "/r/tmdb-movie-603". */
let currentHash = "";
/** The poster image of the last clicked link, to prefer it when a title shows in two lists. */
let clickedPoster: HTMLImageElement | null = null;

/**
 * For each page, the poster link that was last clicked on it: which of the
 * links to that title it was, in page order. A title can show in several rows
 * (Trending and the watchlist); Back returns the poster to the one clicked.
 */
const clickedOn = new Map<string, { href: string; n: number }>();

/** Poster links to a route on the page, in page order. */
const posterLinks = (route: string) =>
  [...app.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => a.querySelector("img") && routeOfHref(a.href) === route);

document.addEventListener(
  "click",
  (e) => {
    const link = (e.target as HTMLElement).closest("a");
    clickedPoster = link?.querySelector("img") ?? null;
    const href = link && routeOfHref(link.href);
    if (clickedPoster && href && app.contains(link)) {
      clickedOn.set(currentHash, { href, n: posterLinks(href).indexOf(link!) });
    }
  },
  true,
);

const isTitlePage = (hash: string) => /^\/(r|tv)\//.test(hash);

/**
 * A visible poster in a link to the given route on the page now shown. The
 * one that was clicked on this page comes first, if it is still there.
 */
function listPoster(hash: string): HTMLImageElement | null {
  const href = hash;
  const links = posterLinks(href);
  const clicked = clickedOn.get(currentHash);
  const order = clicked?.href === href && links[clicked.n] ? [links[clicked.n]!, ...links] : links;
  for (const link of order) {
    const img = link.querySelector("img")!;
    const box = img.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight && box.width) return img;
  }
  return null;
}

/**
 * The title page's poster: the one in the title area, or the rail copy when
 * the page is scrolled down and the rail is on screen.
 */
function titlePoster(): HTMLImageElement | null {
  updateRail();
  const main = app.querySelector<HTMLImageElement>(".title-area .poster");
  const rail = app.querySelector<HTMLImageElement>(".title-rail.shown .rail-poster");
  if (rail?.getBoundingClientRect().width && !(main && isOnScreen(main))) return rail;
  return main;
}

const isOnScreen = (el: Element) => {
  const box = el.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
};

/**
 * A poster that leaves the page before the next page is ready (a search
 * suggestion closes when it is chosen): a copy of it stays at the same screen
 * position until the animation takes it, or for one second at most.
 */
let heldPoster: { img: HTMLImageElement; hash: string } | null = null;

function holdPoster(img: HTMLImageElement | null, hash: string): void {
  heldPoster?.img.remove();
  heldPoster = null;
  const box = img?.getBoundingClientRect();
  if (!img || !box?.width) return;
  const copy = img.cloneNode() as HTMLImageElement;
  Object.assign(copy.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: "0",
    zIndex: "1000",
    pointerEvents: "none",
  });
  document.body.append(copy);
  const held = { img: copy, hash };
  heldPoster = held;
  setTimeout(() => {
    if (heldPoster !== held) return;
    copy.remove();
    heldPoster = null;
  }, 1000);
}

/**
 * The card around a poster, when it has the card layout (poster, bars, title,
 * type and year): a poster card's link, or the title rail. It moves as a
 * whole with the poster when both ends have one.
 */
function cardOf(img: HTMLImageElement): HTMLElement | null {
  return img.closest<HTMLElement>(".cards a, .title-rail.shown .rail-link");
}

/** Give the poster and its card their view-transition names, or clear them. */
function nameMorph(img: HTMLImageElement | null, on: boolean): void {
  if (!img) return;
  img.style.viewTransitionName = on ? "poster" : "";
  const card = cardOf(img);
  if (card) card.style.viewTransitionName = on ? "card" : "";
}

/** How long the poster takes to fall off the screen, in milliseconds. */
const FALL_MS = 900;

/**
 * Make the poster (and its card) of a closing title page tip over to the left
 * and fall off the bottom of the screen in an arc, when the new page has no
 * card for it to move to. The animations drive the view-transition parts of
 * the old poster and card, which have no new element to move to.
 */
function fallOff(poster: DOMRect, card: DOMRect | null): void {
  const outer = card ?? poster;
  // They turn about the card's bottom left corner, which then falls.
  const px = outer.left;
  const py = outer.bottom;
  // Far enough down that no corner stays on the screen, at any angle.
  const drop = window.innerHeight - py + Math.hypot(outer.width, outer.height) + 16;
  const steps = 40;
  const keyframes = (box: DOMRect): Keyframe[] =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps;
      // First it tips about the fixed corner, then it falls: steady sideways,
      // faster and faster down, so it moves in an arc.
      const fall = Math.max(0, (t - 0.25) / 0.75);
      const x = px - 160 * fall;
      const y = py + drop * fall * fall;
      const angle = -100 * t * t;
      return {
        transformOrigin: "0 0",
        transform: `translate(${x}px, ${y}px) rotate(${angle}deg) translate(${box.left - px}px, ${box.top - py}px)`,
      };
    });
  const animate = (box: DOMRect, name: string) =>
    document.documentElement.animate(keyframes(box), {
      duration: FALL_MS,
      easing: "linear",
      // Stay off the screen until the transition ends, which can be a frame
      // later: otherwise the card shows again in its old place.
      fill: "forwards",
      pseudoElement: `::view-transition-group(${name})`,
    });
  animate(poster, "poster");
  if (card) animate(card, "card");
}

/** Wait for an image to be ready to draw, but not for long. */
const imageReady = (img: HTMLImageElement) =>
  Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 300))]);

/**
 * Run render(), animating the poster from the old page to the new one when both
 * pages have it. Direction:
 * - A clicked poster links to the new page (a card, a search result, a
 *   Similar card, or a search suggestion): it moves to the new title page's poster.
 * - Otherwise, leaving a title page (Back): its poster moves to the card for
 *   it on the new page, which can be a list or another title's Similar section,
 *   or to the new page's poster when that is a title page with no such card.
 * - Otherwise (Forward): a visible card for the new title page moves to it.
 */
async function morphPoster(fromHash: string, toHash: string, render: () => Promise<void>): Promise<void> {
  const held = heldPoster?.hash === toHash ? heldPoster.img : null;
  heldPoster = null;
  const clicked =
    held ??
    (clickedPoster?.isConnected && routeOfHref(clickedPoster.closest("a")?.href ?? "") === toHash ? clickedPoster : null);
  clickedPoster = null;
  const toTitle = clicked !== null || (isTitlePage(toHash) && !isTitlePage(fromHash));
  const source = clicked ?? (isTitlePage(fromHash) ? titlePoster() : isTitlePage(toHash) ? listPoster(toHash) : null);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!source || reduce || !document.startViewTransition) {
    held?.remove();
    await render();
    return;
  }
  nameMorph(source, true);
  const sourceBox = source.getBoundingClientRect();
  const sourceCard = cardOf(source)?.getBoundingClientRect() ?? null;
  let target: HTMLImageElement | null = null;
  let falls = false;
  const transition = document.startViewTransition(async () => {
    held?.remove();
    await render();
    target = toTitle ? titlePoster() : listPoster(fromHash);
    // Between two title pages with no card for the old one (a series and its
    // season): poster to poster.
    if (!target && isTitlePage(fromHash) && isTitlePage(toHash)) target = titlePoster();
    if (!target) {
      // Leaving a title page for a page with no card for it: the poster falls
      // off the screen. Otherwise it would stay still and then go out at once.
      if (!toTitle) {
        falls = true;
        // Before the parts are made: style.css keeps the old card from fading.
        document.documentElement.classList.add("poster-falls");
      }
      return;
    }
    nameMorph(target, true);
    await imageReady(target);
  });
  // The parts exist once the transition is ready: start the fall then, in the first frame.
  void transition.ready.then(() => falls && fallOff(sourceBox, sourceCard), () => {});
  await transition.updateCallbackDone.catch(() => {});
  // Clear the names, so the next animation can give them to other elements.
  void transition.finished.finally(() => {
    nameMorph(target, false);
    document.documentElement.classList.remove("poster-falls");
  });
}

// ---------- Scroll position ----------

// Pages render after an await, so the browser's own scroll restore runs
// before the content is there. Instead, each history entry keeps its scroll
// position in history.state, and the browse page also keeps how many cards
// were loaded. Back and Forward return there; a new page starts at the top.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

interface PageState {
  scrollY: number;
  /** Browse cards on the page, so that many load again before the scroll. */
  cards?: number;
  /** Pages of the app before this one in history: 0 for the first page. For the back button. */
  depth?: number;
}

/** The depth of the current history entry (see PageState). */
let depth = 0;
let firstRoute = true;

/**
 * Give a new history entry its depth, or read it from an entry that has one
 * (Back, Forward, or a reload). Call at the start of each route.
 */
function trackDepth(saved: PageState | null): void {
  if (typeof saved?.depth === "number") depth = saved.depth;
  else {
    depth = firstRoute ? 0 : depth + 1;
    try {
      history.replaceState({ ...(saved ?? { scrollY: 0 }), depth } satisfies PageState, "");
    } catch {
      // Safari limits replaceState: the button may then be missing on this page.
    }
  }
  firstRoute = false;
  updateBackButton();
}

const backButton = document.querySelector<HTMLButtonElement>("#back-button")!;
/** The installed app: no browser bar, so no browser back button. navigator.standalone: iOS. */
const installed = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * In a browser tab the button is gone. In the installed app it always keeps
 * its space, so the logo does not move, and is only invisible on the first page.
 */
function updateBackButton(): void {
  backButton.hidden = !installed();
  backButton.classList.toggle("away", depth === 0);
}

backButton.addEventListener("click", () => history.back());

// ---------- Header in the installed app ----------

// The installed app has no browser bar, so its header (with the back button)
// stays at the top of the window: it hides while the visitor scrolls down and
// comes back when they scroll up a little. In a browser tab the header scrolls
// away as usual. The header height is in --header-h, and --header-shown is
// that height while the header shows, else 0 (for the fixed rail).

const header = document.querySelector<HTMLElement>(".site-header")!;
/** Scroll distance that counts as a direction, so small movements do not toggle the header. */
const HEADER_SLACK = 8;
let headerY = 0;
/** True during a jump or a scroll restore: the scroll comes from the page, not the visitor. */
let headerHeld = false;
let headerHoldTimer: ReturnType<typeof setTimeout> | undefined;

function setHeaderTucked(tucked: boolean): void {
  header.classList.toggle("tucked", tucked);
  document.documentElement.style.setProperty("--header-shown", tucked ? "0px" : "var(--header-h)");
}

/** Keep the header open while the visitor uses it: the search box, its suggestions, or the first-visit tip. */
function headerInUse(): boolean {
  return header.contains(document.activeElement) || !document.querySelector<HTMLElement>("#concerns-tip")!.hidden;
}

function onHeaderScroll(): void {
  const y = window.scrollY;
  if (headerHeld) {
    headerY = y;
    return;
  }
  if (y <= header.offsetHeight) setHeaderTucked(false);
  else if (y > headerY + HEADER_SLACK && !headerInUse()) setHeaderTucked(true);
  else if (y < headerY - HEADER_SLACK) setHeaderTucked(false);
  else return; // Too small to count: keep the start point.
  headerY = y;
}

/**
 * Set the header for a scroll that the page makes, and ignore that scroll
 * until it ends: a section jump (tucked, so the section is not under the
 * header) or a page change (open).
 */
function holdHeader(tucked: boolean): void {
  if (!document.documentElement.classList.contains("installed")) return;
  setHeaderTucked(tucked);
  headerHeld = true;
  clearTimeout(headerHoldTimer);
  const release = () => {
    clearTimeout(headerHoldTimer);
    headerHeld = false;
    headerY = window.scrollY;
  };
  // scrollend is not in every browser: the timer ends the hold there.
  window.addEventListener("scrollend", release, { once: true });
  headerHoldTimer = setTimeout(release, 1000);
}

function startInstalledHeader(): void {
  if (!installed()) return;
  document.documentElement.classList.add("installed");
  new ResizeObserver(() => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`)).observe(header);
  setHeaderTucked(false);
  window.addEventListener("scroll", onHeaderScroll, { passive: true });
  // The "/" shortcut or Tab can focus the search box while the header is hidden.
  header.addEventListener("focusin", () => setHeaderTucked(false));
}
startInstalledHeader();

/** True from the start of route() until the scroll position is set, so no wrong position is saved. */
let routing = false;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;

const browseCardCount = () => app.querySelectorAll("#browse-results .cards > li").length;

function saveScroll(): void {
  if (routing) return;
  const state: PageState = { scrollY: Math.round(window.scrollY), depth };
  const cards = browseCardCount();
  if (cards) state.cards = cards;
  try {
    history.replaceState(state, "");
  } catch {
    // Safari limits how often replaceState may run; the next scroll saves it.
  }
}

window.addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveScroll, 150);
  },
  { passive: true },
);

// Save at once when a link opens another page, in case the last scroll is not saved yet.
document.addEventListener(
  "click",
  (e) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link || !routeOfHref(link.href)) return;
    clearTimeout(scrollTimer);
    saveScroll();
  },
  true,
);

/** Load browse pages until the page has `count` cards (or all of them). */
async function loadBrowseCards(count: number, seq: number): Promise<void> {
  while (seq === navSeq && browseCardCount() < count) {
    const button = app.querySelector<HTMLButtonElement>("#browse-results button[data-more]");
    if (!button) break; // All loaded, or an error.
    // The scroll observer may have started a page already: wait for it.
    if (button.disabled) await new Promise((resolve) => setTimeout(resolve, 50));
    else await showMoreBrowse(button);
  }
}

async function restoreScroll(saved: PageState | null, seq: number): Promise<void> {
  if (saved?.cards) await loadBrowseCards(saved.cards, seq);
  if (seq !== navSeq) return;
  holdHeader(false);
  window.scrollTo({ top: saved?.scrollY ?? 0, behavior: "instant" });
  routing = false;
}

// ---------- Search suggestions ----------

/**
 * Rated and popular titles that match the search box, shown below it as the
 * visitor types. The last row always searches the catalogs for the text, so a
 * visitor who does not see the title knows the next step.
 */
const suggestBox = document.querySelector<HTMLUListElement>("#suggestions")!;
let suggestions: Suggestion[] = [];
/** Index of the highlighted suggestion, or -1. */
let activeSuggestion = -1;
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
/** Raised for each request and on close, so a late answer for older text is ignored. */
let suggestSeq = 0;

/** The search text that the suggestion list was last made for. */
let suggestQuery = "";

function closeSuggestions(): void {
  suggestQuery = "";
  suggestSeq++;
  clearTimeout(suggestTimer);
  suggestions = [];
  activeSuggestion = -1;
  suggestBox.hidden = true;
  suggestBox.innerHTML = "";
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

/** The smallest poster size each catalog has (TMDB w92, Open Library S), for the 32px thumbnails. */
const thumbUrl = (url: string) => url.replace("/t/p/w185/", "/t/p/w92/").replace(/-M\.jpg$/, "-S.jpg");

function showSuggestions(items: Suggestion[], q: string): void {
  suggestions = items;
  activeSuggestion = -1;
  searchInput.removeAttribute("aria-activedescendant");
  suggestBox.innerHTML = `${items
    .map(
      (s, i) => `
      <li role="option" id="suggestion-${i}" data-index="${i}" aria-selected="false">
        ${s.imageUrl ? `<img src="${esc(thumbUrl(s.imageUrl))}" alt="" width="32" height="48" />` : `<span class="noimg" aria-hidden="true"></span>`}
        <span>
          ${esc(s.title)}${s.subtitle ? ` <span class="muted">— ${esc(s.subtitle)}</span>` : ""}${s.years ? ` <span class="muted">(${esc(s.years)})</span>` : ""}
          <span class="badge">${KIND_LABEL[s.kind]}</span>
          ${s.rated === false ? `<span class="unrated muted small">Not rated yet</span>` : ""}
        </span>
      </li>`,
    )
    .join("")}
      <li role="option" id="suggestion-${items.length}" data-index="${items.length}" aria-selected="false" class="search-all">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
        <span>Search all movies, TV shows, and books for “${esc(q)}”</span>
      </li>`;
  suggestBox.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
}

async function loadSuggestions(q: string): Promise<void> {
  const seq = ++suggestSeq;
  const items = await suggest(q).catch(() => [] as Suggestion[]);
  // Skip the answer if the text changed, the list was closed, or the box lost focus meanwhile.
  if (seq !== suggestSeq || document.activeElement !== searchInput) return;
  showSuggestions(items, q);
}

function highlightSuggestion(i: number): void {
  activeSuggestion = i;
  for (const li of suggestBox.querySelectorAll<HTMLElement>("[role=option]")) {
    li.setAttribute("aria-selected", String(Number(li.dataset.index) === i));
  }
  if (i < 0) {
    searchInput.removeAttribute("aria-activedescendant");
    return;
  }
  searchInput.setAttribute("aria-activedescendant", `suggestion-${i}`);
  document.getElementById(`suggestion-${i}`)?.scrollIntoView({ block: "nearest" });
}

function openSuggestion(i: number): void {
  const s = suggestions[i];
  // The last row: search the catalogs for the text.
  if (!s) {
    searchInput.blur(); // Phones: close the keyboard, as for a title.
    return searchForm.requestSubmit();
  }
  // The list closes now; a copy of the thumbnail stays for the poster animation.
  holdPoster(document.querySelector<HTMLImageElement>(`#suggestion-${i} img`), routeOfHref(pageHref(s))!);
  closeSuggestions();
  searchInput.blur(); // Phones: close the keyboard, so the page is visible.
  navigate(pageHref(s));
}

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  // Same text (e.g. a space at the end, or a keyboard that re-sends its word):
  // nothing to do. Redrawing the list and its ARIA state on every such event
  // closed the Android keyboard while space was held for the language chooser.
  if (q === suggestQuery) return;
  clearTimeout(suggestTimer);
  if (q.length < 2) return closeSuggestions();
  suggestQuery = q;
  // Loaded lists answer at once; while they load, wait for a pause in typing.
  if (titlesReady()) void loadSuggestions(q);
  else suggestTimer = setTimeout(() => void loadSuggestions(q), 150);
});

searchInput.addEventListener("focus", preloadSearch);

searchInput.addEventListener("keydown", (e) => {
  const open = !suggestBox.hidden;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open) return;
    e.preventDefault();
    const n = suggestions.length + 1; // With the "Search all" row.
    // Wraps through "none highlighted" (-1), so the visitor can go back to the typed text.
    const next = e.key === "ArrowDown" ? activeSuggestion + 1 : activeSuggestion - 1;
    highlightSuggestion(next >= n ? -1 : next < -1 ? n - 1 : next);
  } else if (e.key === "Enter" && open && activeSuggestion >= 0) {
    e.preventDefault(); // Open the title instead of searching.
    openSuggestion(activeSuggestion);
  } else if (e.key === "Escape" && open) {
    e.preventDefault(); // Close the list only; keep the typed text.
    closeSuggestions();
  }
});

searchInput.addEventListener("blur", () => closeSuggestions());

// mousedown would move focus off the search box and close the list before the click.
suggestBox.addEventListener("mousedown", (e) => e.preventDefault());
suggestBox.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
  if (li) openSuggestion(Number(li.dataset.index));
});

// "/" or Ctrl+K (Cmd+K on a Mac) moves to the search box from anywhere on the page.
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target as HTMLElement;
  const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  const slash = e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
  const ctrlK = e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (!slash && !ctrlK) return;
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
});

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  closeSuggestions();
  const q = searchInput.value.trim();
  if (q.length >= 2) navigate(`/search#q=${encodeURIComponent(q)}`);
});

app.addEventListener("click", (e) => {
  const filter = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]")?.dataset.filter;
  if (filter) {
    saveSearchFilter(filter as SearchFilter);
    applySearchFilter(filter as SearchFilter);
    return;
  }

  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-card-action]");
  if (action) {
    cardAction(action);
    return;
  }

  const mark = (e.target as HTMLElement).closest<HTMLButtonElement>("#marks button[data-mark]");
  if (mark) {
    toggleMark(mark);
    return;
  }

  if ((e.target as HTMLElement).closest("button[data-watch-more]")) {
    watchExpandedFor = watchId;
    renderWatch();
    return;
  }

  const more = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-more]");
  if (more) {
    void showMoreBrowse(more);
    return;
  }

  const shuffle = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-browse-shuffle]");
  if (shuffle?.form) {
    shuffle.form.querySelector<HTMLInputElement>("input[name=seed]")!.value = newSeed();
    void updateBrowse(shuffle.form);
    return;
  }

  if ((e.target as HTMLElement).closest("button[data-browse-clear]")) {
    // Filter changes replace the URL without a new history entry, so the URL may already match.
    clearTimeout(browseTyping);
    if (location.pathname === "/browse" && !location.hash) void route();
    else navigate("/browse");
    return;
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if ((e.target as HTMLElement).closest("button[data-top]")) {
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    // Keyboard users continue from the jump links (at the top, or in the rail on wide screens).
    [...app.querySelectorAll<HTMLElement>(".jumps button, .rail-jumps button")]
      .find((b) => b.offsetParent !== null)
      ?.focus({ preventScroll: true });
    return;
  }

  const id = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-jump]")?.dataset.jump;
  if (!id) return;
  holdHeader(true);
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
});

// Offline use (public/sw.js). Not in development: Vite serves modules that change on each edit.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

const offlineNote = document.querySelector<HTMLElement>("#offline-note")!;
const updateOffline = () => (offlineNote.hidden = navigator.onLine);
window.addEventListener("online", updateOffline);
window.addEventListener("offline", updateOffline);
updateOffline();

// Phone testing: ?debug in the URL (before the #) shows an event log. See debug.ts.
if (new URLSearchParams(location.search).has("debug")) {
  void import("./debug.js").then((m) => m.startDebugLog());
}

// Links from before the real paths: /#/r/tmdb-movie-603, /#/browse?kind=movie.
if (location.pathname === "/" && location.hash.startsWith("#/")) {
  const [route, state] = location.hash.slice(1).split(/\?(.*)/s);
  const old = /^\/(?:r\/([\w-]+)|tv\/(\d+))$/.exec(route!);
  const path = old ? (idPath(old[1] ?? `tmdb-tv-${old[2]}`) ?? "/") : route;
  history.replaceState(history.state, "", `${path}${location.search}${state ? `#${state}` : ""}`);
}

// Links to app pages change the page without a new page load.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as HTMLElement).closest("a");
  if (!link || link.target || link.hasAttribute("download") || !routeOfHref(link.href)) return;
  e.preventDefault();
  // Same page and state (the logo on the home page): no new history entry, as with a hash link before.
  const url = new URL(link.href);
  if (url.pathname === location.pathname && url.hash === location.hash) return;
  navigate(url.pathname + location.search + url.hash);
});

window.addEventListener("popstate", () => void route());
void route();
// Load the rated titles when the browser is idle, on any first page, so search,
// browse, and the watchlist bars need no wait later.
prefetchTitles();
