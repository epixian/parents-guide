# parents-guide

AI summaries of parental concerns for movies, TV shows, and books. A user searches a title, picks the correct match, and gets a summary plus a 0-5 score for each concern category (violence, language, sexual content, and more). Users hide the categories they do not care about, and can set concern limits (a highest level per category, and treatments to leave out), on the Preferences page (`#/preferences`, the gear in the header); these choices stay in the browser (`localStorage`). Browse applies the saved limits to every request, and a toggle above the list shows the titles over them (`limits=off` in the page URL). Each title page also has a watchlist button and the user's own thumbs up or down (TV seasons use their series); these also stay in the browser. The home page lists the newest 8 watchlist titles above "Trending this week", with a "Show all" link to the watchlist page (`#/watchlist`) when there are more. Below it, "Recommended for you" lists rated titles that the browser picks from the thumbs: theme tags of liked titles count for a title and those of disliked titles count against it, and after 3 liked titles, concern scores above the highest among them count against it too (see `src/shared/recommend.ts`). Every poster card and search result has a watchlist toggle over its poster (on hover or focus), and recommended cards also have "Not interested"; "Not interested" only hides the title from the recommendations. The thumbs and these choices never leave the browser.

## How it works

1. `GET /api/search?q=` searches TMDB (movies, TV) and Open Library (books).
2. `GET /api/report/:id` returns the cached result for one work, or runs one AI lookup (Claude Haiku 4.5) on a cache miss and caches it.
   - Ids: `tmdb-movie-603`, `tmdb-tv-1399-s01` (one TV season), `ol-OL27482W`.
3. `GET /api/tv/:tmdbId` returns the season list, the cached season results, and the series range (min-max per category). It never calls the AI.
4. `GET /api/titles` returns every saved title in one list, with an `ETag`. The browser filters, sorts, and pages this list for the browse page and for the suggestions below the search box, so filters work with no request. The browser keeps its copy and asks for changes with the `ETag`; the answer is an empty 304 until a title is added or changed. The filters are type, title text, theme tags, the highest allowed score per category (`max.violence=2`), and treatments to leave out (`hide.lgbtq=approving`). The browse page keeps the same query in its URL (`#/browse?...`), so a filtered list can be bookmarked or shared. Suggestions put exact matches first, then titles that start with the text, then titles with a word that starts with it. See `src/shared/browse.ts` and `src/client/titles.ts`.
5. `GET /api/browse` and `GET /api/suggest?q=` do the same filtering on the server, with the same code. The browser uses them when the visitor turned on data saver, or when the list does not load. None of these endpoints call the catalogs or the AI.
6. `GET /api/mood/:id` returns the mood of a saved result: tone (1 bleak to 5 uplifting; shown as "Outlook"), feeling (1 low-key to 5 powerful; shown as "Pull"), and depth (1 silly to 5 profound), shown as three bars in the Summary section. A result saved before moods existed gets one from a light AI prompt (about $0.001) on the first request, and the result is saved. `npm run backfill:mood` adds the rest at batch prices.

7. `GET /api/watch/:id` returns the US streaming services for a movie or TV series (`tmdb-movie-603`, `tmdb-tv-1399`; a season id gets the series' services). It keeps subscription, free, and free-with-ads services, and leaves out rent and buy. TMDB lists some brands many times (Starz, Starz Amazon Channel, Starz Apple TV channel); the server groups them into one entry, and puts the top 10 US services first (`TOP` in `src/server/watchProviders.ts`). A title page shows up to 3 logos and a "+N more" link. `GET /api/providers` returns every US service, for "My services" on the Preferences page. TMDB has this data from JustWatch; the site footer credits JustWatch. Users uncheck the services they do not have, and that choice stays in the browser (`localStorage`), like the hidden categories.

8. `GET /api/similar/:id` returns the rated titles that TMDB recommends for a movie or TV series (a season id gets the series' list). The page shows them in a "Similar titles" section between Summary and Details. TMDB's "similar" list matches only on genres and keywords and gives poor results, so the server uses TMDB recommendations. It answers with every rated title in the list, in TMDB's order. The browser puts titles that share theme tags with the titles the user liked (thumbs up) first, and shows 12 (see `src/shared/similar.ts`).

The AI prompt always covers every category, so one cached result serves every user. Filtering happens in the browser.

### Cache and refresh policy

Each result is one JSON file in `CACHE_DIR`:

```
<CACHE_DIR>/movie/603.json
<CACHE_DIR>/tv/1399/s01.json
<CACHE_DIR>/book/OL27482W.json
```

Results refresh only when someone requests them, based on the title's age (see `src/server/refreshPolicy.ts`):

| Title age | Min. time since last refresh |
|---|---|
| < 1 week | 3 days |
| 1 week to < 1 month | 1 week |
| 1 month to < 3 months | 1 month |
| 3 months to < 6 months | 3 months |
| 6 months to < 1 year | 6 months |
| 1 year to < 2 years | 1 year |
| 2 years or more | never |

Catalog facts (credits, poster, and the audience score from TMDB or Open Library) are reloaded on the next view when they are more than 30 days old. This is a catalog call only, with no AI cost. A book keeps the publisher that the AI gave.

Streaming services are kept for one day in `<CACHE_DIR>/watch/`. The first request after that day gets them from TMDB again and replaces the file. If TMDB fails, the server uses the older file for up to one week. Files older than one week are deleted. For the Browse filter "On my services", the server also looks up every rated movie and TV series: at startup and then every hour. Each sweep asks TMDB again only for titles with no file or a file older than one day, and makes at most 300 TMDB requests, with a pause of 250 ms after each one. Other titles use their file, at any age, until a later sweep (`SWEEP_MAX_FETCHES` in `src/server/index.ts`).

Similar titles are kept for one week in `<CACHE_DIR>/similar/`, in the same way (fallback up to 30 days).

No AI lookup happens before the release date. A TV season's age comes from its most recent aired episode. A book with only a publication year uses January 1 of that year.

## Local development

Requirements: Node.js 22 or later.

```sh
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY and TMDB_API_KEY
```

Run the API and the web app in two terminals:

```sh
npm run dev:api      # API on http://localhost:8787 (restarts on change)
npm run dev:client   # Web app on http://localhost:5188 (proxies /api)
```

Other commands:

```sh
npm test             # unit tests
npm run typecheck
npm run build        # dist/server + dist/client
npm start            # production server (serves the built client too)
npm run backup:sync  # copy CACHE_DIR to the S3 backup bucket (--restore to copy back)
```

A production build needs only `npm ci`, `npm run build`, and `npm start`, with a
`.env` beside it. Set `CACHE_DIR` to an absolute path outside the checkout, so
deploys never touch saved results. Behind a reverse proxy, set `TRUST_PROXY=1`
so the per-IP limit uses the client address; the server listens on
`127.0.0.1` unless `HOST` says otherwise.

### Off-site backup

Set the `S3_*` values in `.env` to copy every saved result to an S3-compatible
bucket (AWS S3, DigitalOcean Spaces, Cloudflare R2, Backblaze B2, MinIO) as soon
as it is written. The view counts and the usage log go up every 10 minutes. The
local disk stays the source of truth, and a failed upload never fails a request.
Run `npm run backup:sync` once for the files saved before the backup was on, and
`npm run backup:sync -- --restore` to copy the bucket back into an empty `CACHE_DIR`.

Configuration lives in `.env` (see `.env.example`). Change the category list in `src/shared/categories.ts`, and bump `PROMPT_VERSION` in `src/server/classify.ts` when you change it or the prompt.

## AI usage and cost

Every AI call writes one line to the server log, for example
`AI usage tmdb-movie-603 (live): in=3412 out=1480 cost≈$0.0108`, and one JSON
line to `<CACHE_DIR>/usage.jsonl`. To total the cost:

```sh
node -e 'let t=0;for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n"))if(l)t+=JSON.parse(l).cost??0;console.log("$"+t.toFixed(2))' data/cache/usage.jsonl
```

## Rating many titles at batch prices

`npm run batch -- <ids-file> [--dry-run]` rates a list of report ids through the
Batch API at half price. See the comment at the top of `src/server/batch.ts`.
