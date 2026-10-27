// Page paths. A title page has its kind, its catalog id, and a slug:
//
//   /movie/603/the-matrix-1999             tmdb-movie-603
//   /book/OL82563W/the-hobbit              ol-OL82563W
//   /tv/1399/game-of-thrones-2011          tmdb-tv-1399 (the series page)
//   /tv/1399/season/1/game-of-thrones-2011 tmdb-tv-1399-s01
//
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

/** The page path of a report or series id, without the slug. Null for an id of no known kind. */
export function idPath(id: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^tmdb-movie-(\d+)$/.exec(id))) return `/movie/${m[1]}`;
  if ((m = /^ol-(OL\d+W)$/.exec(id))) return `/book/${m[1]}`;
  if ((m = /^tmdb-tv-(\d+)-s(\d+)$/.exec(id))) return `/tv/${m[1]}/season/${Number(m[2])}`;
  if ((m = /^tmdb-tv-(\d+)$/.exec(id))) return `/tv/${m[1]}`;
  return null;
}

/** The report or series id of a title page path (any slug, or none), or null when it is not a title page. */
export function pathId(pathname: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^\/movie\/(\d+)(?:\/[^/]*)?$/.exec(pathname))) return `tmdb-movie-${m[1]}`;
  if ((m = /^\/book\/(OL\d+W)(?:\/[^/]*)?$/.exec(pathname))) return `ol-${m[1]}`;
  if ((m = /^\/tv\/(\d+)\/season\/(\d+)(?:\/[^/]*)?$/.exec(pathname))) return `tmdb-tv-${m[1]}-s${String(Number(m[2])).padStart(2, "0")}`;
  if ((m = /^\/tv\/(\d+)(?:\/[^/]*)?$/.exec(pathname))) return `tmdb-tv-${m[1]}`;
  return null;
}

/** The page of a title, with its slug: a report id, or a series id (tmdb-tv-1399) for TV. */
export function titlePath(item: { id: string; kind?: MediaKind; title: string; years?: string | null }): string {
  const base = idPath(item.id);
  if (!base) return "/";
  const s = slug(item.title, item.years);
  return s ? `${base}/${s}` : base;
}
