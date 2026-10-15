# Pairents' Gaide

AI summaries of parental concerns for movies, TV shows, and books. A user searches a title, picks the correct match, and gets a summary plus a 0-5 score for each concern category (violence, language, sexual content, and more). Users hide the categories they do not care about; that choice stays in the browser (`localStorage`).

## How it works

1. `GET /api/search?q=` searches TMDB (movies, TV) and Open Library (books).
2. `GET /api/report/:id` returns the cached result for one work, or runs one AI lookup (Claude Haiku 4.5) on a cache miss and caches it.
   - Ids: `tmdb-movie-603`, `tmdb-tv-1399-s01` (one TV season), `ol-OL27482W`.
3. `GET /api/tv/:tmdbId` returns the season list, the cached season results, and the series range (min-max per category). It never calls the AI.

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
npm test             # refresh policy tests
npm run typecheck
npm run build        # dist/server + dist/client
npm start            # production server (serves the built client too)
```

Configuration lives in `.env` (see `.env.example`). Change the category list in `src/shared/categories.ts`, and bump `PROMPT_VERSION` in `src/server/classify.ts` when you change it or the prompt.

## AI usage and cost

Every AI call writes one line to the server log, for example
`AI usage tmdb-movie-603 (live): in=3412 out=1480 cost≈$0.0108`, and one JSON
line to `<CACHE_DIR>/usage.jsonl`. To total the cost:

```sh
node -e 'let t=0;for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n"))if(l)t+=JSON.parse(l).cost??0;console.log("$"+t.toFixed(2))' /path/to/cache/usage.jsonl
```

## Rating many titles at batch prices

The Batch API costs half the normal price. Results take minutes to hours, so
use it to fill the cache before launch, not for live requests.

1. Write a file with one report id per line (`#` starts a comment):

   ```
   tmdb-movie-603
   tmdb-tv-1399-s01
   ol-OL27482W
   ```

2. Check what it will do (no AI calls, no cost):

   ```sh
   npm run batch -- titles.txt --dry-run      # production build
   npm run batch:dev -- titles.txt --dry-run  # on a dev machine, no build needed
   ```

3. Run it without `--dry-run`. The script skips saved and unreleased titles,
   sends one batch, waits for it, and saves each result to `CACHE_DIR`. If the
   script stops, run `npm run batch -- --resume <batch-id>` with the id it printed.

4. Restart the server, so the home page lists include the new titles.

On the server, run it from the site's `current` directory, so it uses the
site's `.env` and writes straight to the production cache. To run it on a dev
machine instead, copy the results up without replacing anything the server has:

```sh
rsync -av --ignore-existing --exclude popularity.json --exclude usage.jsonl \
  data/cache/ forge@your-droplet:/path/to/cache/
```

## Deploying (DigitalOcean droplet + Laravel Forge)

The cache must live outside the git checkout, so deploys never touch it.

1. **Create the site** in Forge for your domain, pointing at this repository. Turn on quick deploy (auto deploy on push).
2. **Create the cache directory** on the server (as the `forge` user):

   ```sh
   mkdir -p /path/to/cache
   ```

3. **Environment**: in the site's environment settings, set:

   ```
   ANTHROPIC_API_KEY=...
   TMDB_API_KEY=...
   PORT=8787
   CACHE_DIR=/path/to/cache
   TRUST_PROXY=1
   AI_LOOKUPS_PER_IP_PER_HOUR=30
   ```

   Forge writes these to `.env` in the site directory, and the server reads that file at startup. `.env` is in `.gitignore`.

4. **Deploy script**: replace the default (PHP) script with:

   ```sh
   cd $FORGE_SITE_PATH
   git pull origin $FORGE_SITE_BRANCH
   npm ci
   npm run build
   sudo -S supervisorctl restart daemon-XXXXX:*   # replace with your daemon's name from Forge
   ```

   If your Forge setup uses a different restart command for daemons, use that. You can also restart the daemon from the Forge UI.

5. **Daemon**: add a daemon on the server:
   - Command: `node dist/server/index.js`
   - Directory: the site directory (for example `/home/forge/your-domain.com`)
   - User: `forge`

6. **Nginx**: edit the site's Nginx config so requests go to the Node server. Replace the `location /` block with:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8787;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 120s;
   }
   ```

   A new AI lookup can take up to about a minute, so keep `proxy_read_timeout` above that.

7. **Node.js**: the server needs Node.js 22 or later. Check with `node --version` on the droplet.

If you later turn on zero-downtime deploys (a new release directory for each deploy), nothing changes: `CACHE_DIR` is an absolute path outside the release directories.
