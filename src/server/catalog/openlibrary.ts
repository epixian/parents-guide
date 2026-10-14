import { fetchJson } from "../http.js";
import { isReleased } from "../refreshPolicy.js";
import type { SearchResult } from "../../shared/types.js";
import { truncate, type WorkDetails } from "./types.js";

const BASE = "https://openlibrary.org";
const HEADERS = { "user-agent": "pairents-guide/0.1", accept: "application/json" };

interface SearchDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
}

function searchDocs(q: string, limit: number): Promise<{ docs: SearchDoc[] }> {
  const params = new URLSearchParams({
    q,
    fields: "key,title,author_name,first_publish_year,cover_i",
    limit: String(limit),
  });
  return fetchJson(`${BASE}/search.json?${params}`, { headers: HEADERS });
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
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  const year = raw && /^\d{4}$/.test(raw) ? Number(raw) : firstPublishYear;
  return year ? `${year}-01-01` : null;
}

export async function getBook(workId: string, now: Date): Promise<WorkDetails> {
  const [work, search] = await Promise.all([
    fetchJson<Work>(`${BASE}/works/${workId}.json`, { headers: HEADERS }),
    searchDocs(`key:/works/${workId}`, 1),
  ]);
  const doc = search.docs[0];
  const releaseDate = publicationDate(work, doc?.first_publish_year);
  const description = typeof work.description === "string" ? work.description : work.description?.value;

  const context = [
    `Type: book`,
    `Title: ${work.title}`,
    doc?.author_name?.length ? `Author: ${doc.author_name.join(", ")}` : "",
    `First published: ${releaseDate ?? "unknown"}`,
    description ? `Description: ${truncate(description, 2000)}` : "",
    work.subjects?.length ? `Subjects: ${work.subjects.slice(0, 40).join(", ")}` : "",
    work.subject_people?.length ? `Characters: ${work.subject_people.slice(0, 20).join(", ")}` : "",
    work.subject_times?.length ? `Time periods: ${work.subject_times.slice(0, 10).join(", ")}` : "",
  ].filter(Boolean);

  return {
    title: work.title,
    subtitle: doc?.author_name?.length ? `by ${doc.author_name.slice(0, 3).join(", ")}` : null,
    releaseDate,
    // Unknown publication date: allow rating (almost always an older book).
    released: releaseDate === null || isReleased(releaseDate, now),
    context,
  };
}
