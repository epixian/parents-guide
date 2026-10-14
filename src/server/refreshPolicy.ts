// Cache refresh policy. Refreshes happen only when a user searches a title.
//
// The age of the title selects a bucket. Each bucket sets the minimum time
// since the last refresh before a new AI lookup is allowed. Titles 2 years old
// or more are stable and never refresh.

type Span = { days?: number; months?: number; years?: number };

interface Bucket {
  /** The title is in this bucket while its age is less than this span. */
  maxAge: Span;
  /** Minimum time since the last refresh. */
  minGap: Span;
}

export const BUCKETS: readonly Bucket[] = [
  { maxAge: { days: 7 }, minGap: { days: 3 } },
  { maxAge: { months: 1 }, minGap: { days: 7 } },
  { maxAge: { months: 3 }, minGap: { months: 1 } },
  { maxAge: { months: 6 }, minGap: { months: 3 } },
  { maxAge: { years: 1 }, minGap: { months: 6 } },
  { maxAge: { years: 2 }, minGap: { years: 1 } },
];

export function addSpan(date: Date, span: Span): Date {
  const d = new Date(date.getTime());
  if (span.years) d.setUTCFullYear(d.getUTCFullYear() + span.years);
  if (span.months) d.setUTCMonth(d.getUTCMonth() + span.months);
  if (span.days) d.setUTCDate(d.getUTCDate() + span.days);
  return d;
}

/** Parse YYYY-MM-DD (or YYYY) as midnight UTC. */
export function parseReleaseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01"] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Release gate: no AI lookup until the current date is on or after the release date. */
export function isReleased(releaseDate: string | null, now: Date): boolean {
  const release = parseReleaseDate(releaseDate);
  return release !== null && now.getTime() >= release.getTime();
}

/**
 * Decide if a cached result must be refreshed on this search.
 * A null release date (unknown, books only) is treated as stable.
 */
export function shouldRefresh(args: {
  releaseDate: string | null;
  refreshedAt: string;
  now: Date;
}): boolean {
  const release = parseReleaseDate(args.releaseDate);
  if (!release) return false;
  const refreshedAt = new Date(args.refreshedAt);
  if (Number.isNaN(refreshedAt.getTime())) return true;

  for (const bucket of BUCKETS) {
    if (args.now < addSpan(release, bucket.maxAge)) {
      return args.now >= addSpan(refreshedAt, bucket.minGap);
    }
  }
  return false;
}
