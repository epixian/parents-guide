/** Error with an HTTP status for the API layer. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 429 | 502 | 503,
    message: string,
    /** The upstream service's HTTP status, when this error wraps one. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new HttpError(502, `Upstream request failed: ${(err as Error).message}`);
  }
  if (res.status === 404) throw new HttpError(404, "Not found");
  if (!res.ok) throw new HttpError(502, `Upstream returned ${res.status}`, res.status);
  return (await res.json()) as T;
}
