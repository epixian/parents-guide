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
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
