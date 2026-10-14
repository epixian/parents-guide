/** In-memory sliding-window limiter. Counts only AI lookups, not cache hits. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record one hit for the key. Returns false if the key is over the limit. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop expired entries so the map does not grow without bound. */
  sweep(now = Date.now()): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length) this.hits.set(key, recent);
      else this.hits.delete(key);
    }
  }
}
