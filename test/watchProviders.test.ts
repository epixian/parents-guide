import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { streamingProviders } from "../src/server/catalog/tmdb.js";
import { HttpError } from "../src/server/http.js";
import { WatchService, brandKey, groupProviders } from "../src/server/watchProviders.js";
import type { ProviderEntry } from "../src/server/catalog/tmdb.js";

const item = (id: number, name: string, priority: number) => ({
  provider_id: id,
  provider_name: name,
  logo_path: `/${id}.png`,
  display_priority: priority,
});

test("streamingProviders keeps subscription, free, and ads offers once each, without rent or buy", () => {
  const providers = streamingProviders({
    flatrate: [item(1899, "HBO Max", 151), item(8, "Netflix", 1)],
    ads: [item(8, "Netflix", 1), item(207, "The Roku Channel", 29)],
    rent: [item(10, "Amazon Video", 8)],
    buy: [item(2, "Apple TV Store", 9)],
  });
  assert.deepEqual(
    providers.map((p) => p.name),
    ["Netflix", "The Roku Channel", "HBO Max"],
  );
  assert.equal(providers[0]!.logoUrl, "https://image.tmdb.org/t/p/w92/8.png");
  // Netflix is in both lists: "free with ads" wins.
  assert.deepEqual(
    providers.map((p) => p.offer),
    ["ads", "ads", "subscription"],
  );
  assert.deepEqual(streamingProviders(undefined), []);
  // TMDB's "free" shows like a subscription.
  assert.equal(streamingProviders({ free: [item(212, "Hoopla", 36)] })[0]!.offer, "subscription");
});

const entry = (id: number, name: string): ProviderEntry => ({ id, name, logoUrl: `/${id}.png` });

test("groupProviders shows one entry per brand, with the main service's name and logo", () => {
  const jurassicPark = [
    entry(2383, "Philo"),
    entry(1794, "Starz Amazon Channel"),
    entry(43, "Starz"),
    entry(1855, "Starz Apple TV channel"),
  ];
  assert.deepEqual(groupProviders(jurassicPark), [
    { id: 2383, name: "Philo", logoUrl: "/2383.png", ids: [2383], rank: null },
    { id: 43, name: "Starz", logoUrl: "/43.png", ids: [1794, 43, 1855], rank: null },
  ]);

  // The top 10 come first, most used first; the others keep TMDB's order.
  const order = groupProviders([entry(2383, "Philo"), entry(15, "Hulu"), entry(43, "Starz"), entry(8, "Netflix")]);
  assert.deepEqual(
    order.map((p) => [p.name, p.rank]),
    [["Netflix", 0], ["Hulu", 3], ["Philo", null], ["Starz", null]],
  );

  // The main service is not in the list: take it from the catalog, else name the brand.
  const channelOnly = [entry(582, "Paramount+ Amazon Channel")];
  assert.deepEqual(groupProviders(channelOnly, new Map([["paramountplus", entry(531, "Paramount Plus")]])), [
    { id: 531, name: "Paramount Plus", logoUrl: "/531.png", ids: [582], rank: 5 },
  ]);
  assert.equal(groupProviders(channelOnly)[0]!.name, "Paramount+");

  // A group takes its cheapest offer.
  const prime = groupProviders([
    { ...entry(9, "Amazon Prime Video"), offer: "subscription" },
    { ...entry(613, "Amazon Prime Video Free with Ads"), offer: "ads" },
  ]);
  assert.equal(prime.length, 1);
  assert.equal(prime[0]!.offer, "ads");

  // A local logo where TMDB's is hard to see.
  assert.equal(groupProviders([entry(2528, "YouTube TV")])[0]!.logoUrl, "/logos/youtube-tv.svg");
});

test("brandKey joins plans and store channels, but keeps separate products apart", () => {
  assert.equal(brandKey("Netflix Standard with Ads"), "netflix");
  assert.equal(brandKey("Netflix Kids"), "netflix");
  assert.equal(brandKey("Paramount Plus Essential"), brandKey("Paramount+ Roku Premium Channel"));
  assert.equal(brandKey("AMC Plus Apple TV channel"), brandKey("AMC+"));
  assert.notEqual(brandKey("AMC+"), brandKey("AMC"));
  assert.equal(brandKey("Curiosity Stream"), brandKey("CuriosityStream Amazon Channel"));
  assert.equal(brandKey("Peacock Premium Plus"), brandKey("Peacock Premium"));
  for (const amazon of ["Amazon Video", "Amazon Prime Video with Ads", "Amazon Prime Video Free with Ads"]) {
    assert.equal(brandKey(amazon), brandKey("Amazon Prime Video"));
  }
  assert.equal(brandKey("Sling TV Orange"), brandKey("Sling TV Orange and Blue"));
  assert.notEqual(brandKey("Amazon MX Player"), brandKey("Amazon Prime Video"));
  assert.notEqual(brandKey("YouTube Premium"), brandKey("YouTube"));
  assert.notEqual(brandKey("YouTube TV"), brandKey("YouTube"));
});

async function service(ttlMs = 1000, keepMs = 5000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "watch-cache-"));
  const calls: string[] = [];
  let answer: ProviderEntry[] | Error = [{ id: 8, name: "Netflix", logoUrl: null }];
  const watch = new WatchService(
    dir,
    {
      title: async (kind, id) => {
        calls.push(`${kind}-${id}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      catalog: async () => [],
    },
    ttlMs,
    keepMs,
  );
  return {
    watch,
    calls,
    set: (a: ProviderEntry[] | Error) => (answer = a),
    done: () => fs.rm(dir, { recursive: true }),
  };
}

test("WatchService keeps an answer for the time limit, then fetches again and saves it", async () => {
  const s = await service();
  const first = await s.watch.title("tmdb-movie-603", 0);
  assert.equal(first.region, "US");
  assert.equal(first.providers[0]!.name, "Netflix");
  await s.watch.title("tmdb-movie-603", 999);
  assert.deepEqual(s.calls, ["movie-603"]);

  s.set([{ id: 15, name: "Hulu", logoUrl: null }]);
  const later = await s.watch.title("tmdb-movie-603", 1000);
  assert.equal(later.providers[0]!.name, "Hulu");
  assert.equal(later.fetchedAt, new Date(1000).toISOString());
  await s.watch.title("tmdb-movie-603", 1500);
  assert.deepEqual(s.calls, ["movie-603", "movie-603"]);
  await s.done();
});

test("WatchService gives a season the series' services and refuses other ids", async () => {
  const s = await service();
  await s.watch.title("tmdb-tv-1399-s01", 0);
  await s.watch.title("tmdb-tv-1399", 0);
  assert.deepEqual(s.calls, ["tv-1399"]);
  await assert.rejects(s.watch.title("ol-OL82563W"), (err) => err instanceof HttpError && err.status === 400);
  await assert.rejects(s.watch.title("tmdb-movie-603-s01"), HttpError);
  await s.done();
});

test("WatchService uses an older answer when TMDB fails, but not one past the keep limit", async () => {
  const s = await service();
  await s.watch.title("tmdb-movie-603", 0);
  s.set(new Error("TMDB down"));
  const stale = await s.watch.title("tmdb-movie-603", 2000);
  assert.equal(stale.providers[0]!.name, "Netflix");
  await assert.rejects(s.watch.title("tmdb-movie-603", 5000), /TMDB down/);
  await s.done();
});

test("WatchService makes one TMDB call for requests at the same time", async () => {
  const s = await service();
  await Promise.all([s.watch.title("tmdb-tv-1", 0), s.watch.title("tmdb-tv-1-s02", 0)]);
  assert.deepEqual(s.calls, ["tv-1"]);
  await s.done();
});
