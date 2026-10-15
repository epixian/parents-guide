import type { RecentResponse, ReportResponse, SearchResult, SeriesResponse } from "../shared/types.js";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  search: (q: string) => get<{ results: SearchResult[]; warnings: string[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  report: (id: string) => get<ReportResponse>(`/api/report/${encodeURIComponent(id)}`),
  recent: () => get<RecentResponse>("/api/recent"),
  series: (tmdbId: string) => get<SeriesResponse>(`/api/tv/${encodeURIComponent(tmdbId)}`),
};
