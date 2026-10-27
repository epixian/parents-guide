// Page paths. A title page is /r/<id>/<slug> (TV series: /tv/<tmdb id>/<slug>).
// The slug is the title and year, for search engines and people who read the
// link. Routing ignores it, so an old or wrong slug still opens the page; the
// page's canonical link has the current one.
//
// Page state that can hold the user's choices (browse filters with concern
// limits, the search text) goes after "#" (/browse#max.violence=2,
// /search#q=bella). The browser does not send that part, so it never reaches
// the web server, its logs, or the application backend.

import type { MediaKind } from "./types.js";

/** "The Matrix", "1999" → "the-matrix-1999". Only a-z, 0-9, and "-"; empty when nothing is left. */
export function slug(title: string, years?: string | null): string {
  const year = years?.match(/\d{4}/)?.[0];
  const words = `${title} ${year ?? ""}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.length > 80 ? words.slice(0, 80).replace(/-[^-]*$/, "") : words;
}

/** The page of a title: a report id, or a series id (tmdb-tv-1399) for TV. */
export function titlePath(item: { id: string; kind: MediaKind; title: string; years?: string | null }): string {
  const s = slug(item.title, item.years);
  const base = item.kind === "tv" ? `/tv/${item.id.replace("tmdb-tv-", "")}` : `/r/${item.id}`;
  return s ? `${base}/${s}` : base;
}
