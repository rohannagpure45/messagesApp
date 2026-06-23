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

/**
 * GET `url` with the pmxt bearer key and parse JSON. The key is sent as `Authorization: Bearer`
 * (pmxt's canonical scheme). Times out via AbortController so a slow enrichment call can never
 * hang a reply.
 */
export async function getJson<T>(
  url: string | URL,
  apiKey: string,
  timeoutMs = 6_000,
): Promise<T> {
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
  } finally {
    clearTimeout(timer);
  }
}

/** Never let a key ride in an error string, even if a future caller puts it in the query. */
function redact(url: string | URL): string {
  const s = String(url);
  return s.replace(/(api[_-]?key|token|bearer)=[^&]*/gi, "$1=***");
}
