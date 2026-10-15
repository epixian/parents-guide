import { HttpError, fetchJson } from "../http.js";
import { isReleased } from "../refreshPolicy.js";
import type { SearchResult, WorkInfo } from "../../shared/types.js";
import { audienceScore, credits, truncate, type WorkDetails } from "./types.js";

const BASE = "https://openlibrary.org";
// Open Library allows about 1 request per second, or 3 with a User-Agent that
// names the app and a contact. https://openlibrary.org/developers/api
const HEADERS = { "user-agent": "epixian/pairents-guide/0.1 (+https://example.com)", accept: "application/json" };

/** Space request starts this far apart: just under 3 per second for this process. */
const MIN_GAP_MS = 350;
/** Waits before each retry of a 429 or 503 answer. */
const RETRY_WAITS_MS = [2_000, 5_000];

let nextSlot = 0;

/** Wait for this process's next request slot. */
async function takeSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** fetchJson for Open Library: rate limited, with retries when it says it is busy. */
async function olFetch<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await takeSlot();
    try {
      return await fetchJson<T>(url, { headers: HEADERS });
    } catch (err) {
      const status = err instanceof HttpError ? err.upstreamStatus : undefined;
      const wait = RETRY_WAITS_MS[attempt];
      if ((status !== 429 && status !== 503) || wait === undefined) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

interface SearchDoc {
  key: string;
  title: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  cover_i?: number;
  ratings_average?: number;
  ratings_count?: number;
}

function searchDocs(q: string, limit: number, extraFields = ""): Promise<{ docs: SearchDoc[] }> {
  const params = new URLSearchParams({
    q,
    fields: `key,title,author_name,author_key,first_publish_year,cover_i${extraFields}`,
    limit: String(limit),
  });
  return olFetch(`${BASE}/search.json?${params}`);
}

export async function searchOpenLibrary(query: string): Promise<SearchResult[]> {
  const data = await searchDocs(query, 10);
  return data.docs
    .filter((d) => /^\/works\/OL\d+W$/.test(d.key))
    .map((d) => ({
      id: `ol-${d.key.slice("/works/".length)}`,
      kind: "book" as const,
      title: d.title,
      year: d.first_publish_year ?? null,
      // Same rule as the rating: an unknown year counts as released.
      released: !d.first_publish_year || d.first_publish_year <= new Date().getUTCFullYear(),
      detail: d.author_name?.length ? `by ${d.author_name.slice(0, 3).join(", ")}` : null,
      imageUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg` : null,
    }));
}

interface Work {
  title: string;
  description?: string | { value: string };
  subjects?: string[];
  subject_people?: string[];
  subject_times?: string[];
  first_publish_date?: string;
}

/** Full date when Open Library has one; otherwise Jan 1 of the first publish year. */
function publicationDate(work: Work, firstPublishYear: number | undefined): string | null {
  const raw = work.first_publish_date?.trim();
  if (raw && !/^\d{4}$/.test(raw)) {
    const parsed = Date.parse(`${raw} UTC`);
    // The work record and the search index sometimes disagree (The Hobbit:
    // "January 1938" vs 1937). Trust the full date only if it is not later.
    const iso = Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
    if (iso && (!firstPublishYear || Number(iso.slice(0, 4)) <= firstPublishYear)) return iso;
  }
  const year = raw && /^\d{4}$/.test(raw) ? Number(raw) : firstPublishYear;
  return year ? `${year}-01-01` : null;
}

interface Edition {
  publish_date?: string;
  publishers?: string[];
  languages?: { key: string }[];
}

/**
 * Publisher of the earliest English (or unlabeled) edition. Open Library
 * edition data is noisy, so the AI's answer replaces this when it has one.
 */
function earliestPublisher(editions: Edition[]): string | null {
  let best: { year: number; publisher: string } | null = null;
  for (const e of editions) {
    const publisher = e.publishers?.[0]?.trim();
    const year = Number(/\d{4}/.exec(e.publish_date ?? "")?.[0]);
    const english = !e.languages?.length || e.languages.some((l) => l.key === "/languages/eng");
    if (!publisher || !year || !english) continue;
    if (!best || year < best.year) best = { year, publisher };
  }
  return best?.publisher ?? null;
}

const publisherEntry = (name: string | null) => (name ? { name, url: null } : null);

export async function getBook(workId: string, now: Date): Promise<WorkDetails> {
  const [work, search, editions] = await Promise.all([
    olFetch<Work>(`${BASE}/works/${workId}.json`),
    searchDocs(`key:/works/${workId}`, 1, ",ratings_average,ratings_count"),
    olFetch<{ entries?: Edition[] }>(`${BASE}/works/${workId}/editions.json?limit=100`).catch(
      () => ({ entries: [] as Edition[] }),
    ),
  ]);
  const doc = search.docs[0];
  const releaseDate = publicationDate(work, doc?.first_publish_year);
  const description = typeof work.description === "string" ? work.description : work.description?.value;
  const authors = doc?.author_name ?? [];

  const info: WorkInfo = {
    years: releaseDate ? releaseDate.slice(0, 4) : null,
    rating: null,
    credits: credits([
      [
        "Author",
        authors.slice(0, 3).map((name, i) => {
          const key = doc?.author_key?.[i];
          return { name, url: key && /^OL\d+A$/.test(key) ? `${BASE}/authors/${key}` : null };
        }),
      ],
      ["Publisher", [publisherEntry(earliestPublisher(editions.entries ?? []))]],
    ]),
    imageUrl: doc?.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    source: { name: "Open Library", url: `${BASE}/works/${workId}` },
    // Open Library reader ratings (1-5 stars). Books get fewer ratings than movies get votes.
    audience: audienceScore("Open Library", doc?.ratings_average, doc?.ratings_count, 5, 10),
    fetchedAt: now.toISOString(),
  };

  const context = [
    `Type: book`,
    `Title: ${work.title}`,
    authors.length ? `Author: ${authors.join(", ")}` : "",
    `First published: ${releaseDate ?? "unknown"}`,
    description ? `Description: ${truncate(description, 2000)}` : "",
    work.subjects?.length ? `Subjects: ${work.subjects.slice(0, 40).join(", ")}` : "",
    work.subject_people?.length ? `Characters: ${work.subject_people.slice(0, 20).join(", ")}` : "",
    work.subject_times?.length ? `Time periods: ${work.subject_times.slice(0, 10).join(", ")}` : "",
  ].filter(Boolean);

  return {
    title: work.title,
    subtitle: authors.length ? `by ${authors.slice(0, 3).join(", ")}` : null,
    releaseDate,
    // Unknown publication date: allow rating (almost always an older book).
    released: releaseDate === null || isReleased(releaseDate, now),
    context,
    info,
  };
}
