import type {
  BrowseResponse,
  IndexEntry,
  Mood,
  RecentItem,
  RecentResponse,
  ReportResponse,
  SearchResult,
  SeriesResponse,
  Suggestion,
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
  /** Rated titles that match q, for the search box as the visitor types. */
  suggest: (q: string) => get<Suggestion[]>(`/api/suggest?q=${encodeURIComponent(q)}`),
  /** Mood of a saved result. The server rates it first if the result has none (a few seconds). */
  mood: (id: string) => get<Mood>(`/api/mood/${encodeURIComponent(id)}`),
  report: (id: string) => get<ReportResponse>(`/api/report/${encodeURIComponent(id)}`),
  recent: () => get<RecentResponse>("/api/recent"),
  trending: () => get<RecentItem[]>("/api/trending"),
  /** Every rated title, for browse and suggestions in the browser. Use src/client/titles.ts, not this. */
  titles: () => get<IndexEntry[]>("/api/titles"),
  /** query: the browse filters as a query string (see src/shared/browse.ts). */
  browse: (query: string) => get<BrowseResponse>(`/api/browse?${query}`),
  /** Streaming services for a movie, TV series, or season (the series' services). */
  watch: (id: string) => get<WatchResponse>(`/api/watch/${encodeURIComponent(id)}`),
  /** Every streaming service, for "My services". */
  providers: () => get<WatchProvider[]>("/api/providers"),
  series: (tmdbId: string) => get<SeriesResponse>(`/api/tv/${encodeURIComponent(tmdbId)}`),
};
