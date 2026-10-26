import type {
  CatalogResponse,
  IndexEntry,
  Mood,
  RecentItem,
  RecentResponse,
  ReportResponse,
  SearchResult,
  SeriesResponse,
  Suggestion,
  TitleChanges,
  WatchProvider,
  WatchResponse,
} from "../shared/types.js";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  search: (q: string) => get<{ results: SearchResult[]; warnings: string[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  /** Rated and popular titles that match q, for the search box as the visitor types. */
  suggest: (q: string) => get<Suggestion[]>(`/api/suggest?q=${encodeURIComponent(q)}`),
  /** Mood of a saved result. The server rates it first if the result has none (a few seconds). */
  mood: (id: string) => get<Mood>(`/api/mood/${encodeURIComponent(id)}`),
  report: (id: string) => get<ReportResponse>(`/api/report/${encodeURIComponent(id)}`),
  recent: () => get<RecentResponse>("/api/recent"),
  trending: () => get<RecentItem[]>("/api/trending"),
  /** Every rated title and the tag of this version, for browse and suggestions in the browser. Use src/client/titles.ts, not this. */
  titles: async () => {
    const res = await fetch("/api/titles", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const titles = (await res.json()) as IndexEntry[];
    return { tag: res.headers.get("x-titles-tag"), titles };
  },
  /** The titles that changed after the copy with this tag. Use src/client/titles.ts, not this. */
  titleChanges: (since: string) => get<TitleChanges>(`/api/titles/changes?since=${encodeURIComponent(since)}`),
  /** Popular TMDB titles, for suggestions in the browser. Use src/client/titles.ts, not this. */
  catalog: () => get<CatalogResponse>("/api/catalog"),
  /** Streaming services for a movie, TV series, or season (the series' services). */
  watch: (id: string) => get<WatchResponse>(`/api/watch/${encodeURIComponent(id)}`),
  /** Every streaming service, for "My services". */
  providers: () => get<WatchProvider[]>("/api/providers"),
  /** Rated titles that TMDB recommends for a movie, TV series, or season (the series' list). */
  similar: (id: string) => get<RecentItem[]>(`/api/similar/${encodeURIComponent(id)}`),
  series: (tmdbId: string) => get<SeriesResponse>(`/api/tv/${encodeURIComponent(tmdbId)}`),
};
