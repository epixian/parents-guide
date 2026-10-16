# pairents-guide

AI summaries of parental concerns for movies, TV shows, and books. A user searches a title, picks the correct match, and gets a summary plus a 0-5 score for each concern category (violence, language, sexual content, and more). Users hide the categories they do not care about; that choice stays in the browser (`localStorage`).

## How it works

1. `GET /api/search?q=` searches TMDB (movies, TV) and Open Library (books).
2. `GET /api/report/:id` returns the cached result for one work, or runs one AI lookup (Claude Haiku 4.5) on a cache miss and caches it.
   - Ids: `tmdb-movie-603`, `tmdb-tv-1399-s01` (one TV season), `ol-OL27482W`.
3. `GET /api/tv/:tmdbId` returns the season list, the cached season results, and the series range (min-max per category). It never calls the AI.
4. `GET /api/browse` filters the saved titles by type, title text, theme tags, the highest allowed score per category (`max.violence=2`), and treatments to leave out (`hide.lgbtq=approving`). It never calls the AI. The browse page keeps the same query in its URL (`#/browse?...`), so a filtered list can be bookmarked or shared. See `src/server/browse.ts`.
5. `GET /api/suggest?q=` returns up to 8 saved titles that match the text, for the suggestions below the search box as the visitor types. Exact matches come first, then titles that start with the text, then titles with a word that starts with it. It never calls the catalogs or the AI.

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

No AI lookup happens before the release date. A TV season's age comes from its most recent aired episode. A book with only a publication year uses January 1 of that year.

## Local development

Requirements: Node.js 22 or later.

```sh
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY and TMDB_API_KEY
```

Run with Solo (`solo.yml`) or by hand in two terminals:

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
```

A production build needs only `npm ci`, `npm run build`, and `npm start`, with a
`.env` beside it. Set `CACHE_DIR` to an absolute path outside the checkout, so
deploys never touch saved results. Behind a reverse proxy, set `TRUST_PROXY=1`
so the per-IP limit uses the client address; the server listens on
`127.0.0.1` unless `HOST` says otherwise.

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
