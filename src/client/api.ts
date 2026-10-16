import type {
  BrowseResponse,
  RecentItem,
  RecentResponse,
  ReportResponse,
  SearchResult,
  SeriesResponse,
  Suggestion,
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
  report: (id: string) => get<ReportResponse>(`/api/report/${encodeURIComponent(id)}`),
  recent: () => get<RecentResponse>("/api/recent"),
  trending: () => get<RecentItem[]>("/api/trending"),
  /** query: the browse filters as a query string (see src/server/browse.ts). */
  browse: (query: string) => get<BrowseResponse>(`/api/browse?${query}`),
  series: (tmdbId: string) => get<SeriesResponse>(`/api/tv/${encodeURIComponent(tmdbId)}`),
};
