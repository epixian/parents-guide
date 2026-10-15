import type { AudienceScore, CreditEntry, WorkInfo } from "../../shared/types.js";

/** Metadata about one work (or TV season) that grounds the AI classification. */
export interface WorkDetails {
  title: string;
  subtitle: string | null;
  /** YYYY-MM-DD, or null when unknown. */
  releaseDate: string | null;
  /** True when the release gate passes (released on or before today). */
  released: boolean;
  /** Plain-text metadata lines passed to the AI prompt. */
  context: string[];
  /** Catalog facts shown in the info box. */
  info: WorkInfo;
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Audience score with one decimal, or null when there are fewer than
 * minVotes votes: a handful of votes says little about a title.
 */
export function audienceScore(
  source: string,
  average: number | null | undefined,
  count: number | null | undefined,
  scale: number,
  minVotes: number,
): AudienceScore | null {
  if (!average || !count || count < minVotes) return null;
  return { source, average: Math.round(average * 10) / 10, scale, count };
}

/** Build the credits list, dropping empty and duplicate entries. */
export function credits(groups: [label: string, entries: (CreditEntry | null)[]][]): WorkInfo["credits"] {
  return groups
    .map(([label, entries]) => {
      const seen = new Set<string>();
      const unique = entries.filter((e): e is CreditEntry => {
        if (!e?.name || seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
      });
      return { label, entries: unique };
    })
    .filter((c) => c.entries.length > 0);
}

/** "Label: a, b, c" prompt lines for each credit. */
export function creditLines(info: WorkInfo): string[] {
  return info.credits.map((c) => `${c.label}: ${c.entries.map((e) => e.name).join(", ")}`);
}
