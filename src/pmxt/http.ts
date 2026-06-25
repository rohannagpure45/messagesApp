/**
 * pmxt GET-only HTTP helper. READ-ONLY BY CONSTRUCTION: this module issues only HTTP GET, and
 * only ever against the catalog/read host (`api.pmxt.dev`). The write/trade host (and its
 * signature/escrow surface) is NEVER referenced anywhere under src/pmxt — a static test
 * (tests/read-only.test.ts) enforces this: those literals must not appear in the client at all.
 *
 * Mirrors src/sawa/http.ts; kept separate so the bearer auth header lives only on the pmxt path.
 */

export class PmxtError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PmxtError";
  }
}

/** Backoff before the single transient retry. Injectable so tests don't actually sleep. */
let retryBackoffMs = 250;
/** Test seam: shrink (or zero) the retry backoff so retry tests run instantly. */
export function __setRetryBackoffMs(ms: number): void {
  retryBackoffMs = ms;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET `url` with the pmxt bearer key and parse JSON. The key is sent as `Authorization: Bearer`
 * (pmxt's canonical scheme). Each attempt times out via AbortController (default 9s — raised from
 * 6s after live bursts tripped the old ceiling on responses that normally land <1s) so a slow
 * enrichment call can never hang a reply.
 *
 * Transient failures — a timeout `AbortError` or a network `TypeError` — get ONE retry after a
 * short backoff, since pmxt under burst occasionally responds slowly. An HTTP error (`PmxtError`,
 * any 4xx/5xx) is a definitive answer (no result / auth / rate-limit) and is NEVER retried. The
 * whole path stays fail-soft: a still-failing venue throws to its caller, which degrades to empty.
 */
export async function getJson<T>(
  url: string | URL,
  apiKey: string,
  timeoutMs = 9_000,
  retries = 1,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new PmxtError(res.status, `GET ${redact(url)} → ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      // A real HTTP status is definitive — surface it immediately, never retry.
      if (err instanceof PmxtError) throw err;
      // Transient (timeout abort / network error): one more try after a short backoff.
      if (attempt < retries) {
        clearTimeout(timer);
        await sleep(retryBackoffMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr; // unreachable (loop returns or throws), but satisfies the type checker
}

/** Never let a key ride in an error string, even if a future caller puts it in the query. */
function redact(url: string | URL): string {
  const s = String(url);
  return s.replace(/(api[_-]?key|token|bearer)=[^&]*/gi, "$1=***");
}
