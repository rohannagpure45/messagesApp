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
    /**
     * Whether this HTTP error is worth retrying. Default false (a 4xx/5xx is normally a definitive
     * answer). Set TRUE only for a header-LESS `429` — verified live, pmxt's free tier emits fast
     * (~60ms) transient burst/edge `429`s that clear on the very next call and carry NO `Retry-After`;
     * those are retryable. A `429` WITH `Retry-After` (a real cooldown) stays non-retryable.
     */
    public retryable = false,
  ) {
    super(message);
    this.name = "PmxtError";
  }
}

/**
 * Raised by the CLIENT-SIDE rate guard BEFORE any network call — either the local per-minute cap was
 * reached, or a prior server `429` opened a `Retry-After` pause. It is fail-soft (the caller degrades
 * that venue/sub-query to empty, exactly like a timeout) and is deliberately NOT a `PmxtError` (it
 * carries no HTTP status — no request was made). `retryAfterMs` is how long until the guard reopens.
 */
export class PmxtRateLimitError extends Error {
  constructor(
    public retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "PmxtRateLimitError";
  }
}

/** Backoff before the single transient (timeout / network) retry. Injectable so tests don't sleep. */
let retryBackoffMs = 250;
/** Test seam: shrink (or zero) the retry backoff so retry tests run instantly. */
export function __setRetryBackoffMs(ms: number): void {
  retryBackoffMs = ms;
}
/**
 * Base backoff before a transient-429 retry (grows linearly per attempt: 200, 400). Short on purpose —
 * pmxt's transient 429s clear almost immediately, so a brief wait reclaims the call without adding real
 * latency. Injectable so tests don't sleep.
 */
let rate429BackoffMs = 200;
/** Max transient-429 retries (header-less 429 only). Two is plenty — live, the next call already clears. */
const MAX_RATE_RETRIES = 2;
/** Test seam: shrink (or zero) the 429 retry backoff so rate-retry tests run instantly. */
export function __setRate429BackoffMs(ms: number): void {
  rate429BackoffMs = ms;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Client-side rate guard ─────────────────────────────────────────────────────────────────────
// WHY: the free tier is 60 req/min, and tripping it does NOT just fail the offending call — pmxt then
// `429`s EVERY request for the rest of the minute window, so one rapid burst (an entity-decomposition
// fan-out × several quick messages, ×2 venues) poisons the key and the NEXT legit search comes back
// empty. The staged fan-out + concurrency cap (discover.ts) reduce how many calls a search makes but do
// NOT bound the request RATE — 4 concurrent × ~1s each ≈ 240/min, well over the ceiling under sustained
// testing. So we self-limit two ways, both fail-soft:
//   1. a sliding-window cap (MAX_PER_WINDOW per WINDOW_MS, headroom under 60/min) — never SEND a burst
//      that would trip the server cooldown; excess calls are dropped to an empty slice, never queued
//      (a chat reply must not block on a token), and
//   2. a Retry-After circuit breaker — if a `429` DOES come back (e.g. the key is shared, or our cap is
//      a hair generous) AND the server tells us how long to wait, pause ALL calls until that
//      `Retry-After` elapses instead of hammering. A header-LESS 429 gets NO pause: it's treated as a
//      transient blip so the next query (often the useful decomposed entity) recovers immediately — the
//      cap, not a fixed blackout, is the standing backstop. (An earlier 15s default pause amplified a
//      one-off transient 429 into a 15s outage that killed in-search entity sub-queries — verified live.)
// Injectable clock + reset seam keep it deterministic in tests. The bucket starts full, so normal use
// (~2 calls/search) never waits — only a sustained burst hits the guard.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 55;
/** Cap on an honored Retry-After so a hostile/huge header can't blackout enrichment for minutes. */
const MAX_PAUSE_MS = 30_000;

let httpNow: () => number = () => Date.now();
let windowStart = 0;
let windowCount = 0;
let pausedUntil = 0;

/** Test seam: inject a deterministic clock for the rate guard (mirrors discover.ts `__setClock`). */
export function __setHttpClock(fn: () => number): void {
  httpNow = fn;
}
/** Test seam: clear the rate-guard window + pause between cases. */
export function __resetRateGuard(): void {
  windowStart = 0;
  windowCount = 0;
  pausedUntil = 0;
}

/**
 * Reserve one request slot, or throw `PmxtRateLimitError` (no network) when paused by a server 429 or
 * over the local per-minute cap. Called once at the top of `getJson`, so a fail-soft caller degrades to
 * empty without ever touching the wire.
 */
function reserveSlot(): void {
  const t = httpNow();
  if (t < pausedUntil) {
    throw new PmxtRateLimitError(pausedUntil - t, `pmxt paused after a 429 (~${Math.ceil((pausedUntil - t) / 1000)}s left)`);
  }
  if (t - windowStart >= WINDOW_MS) {
    windowStart = t;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_WINDOW) {
    throw new PmxtRateLimitError(
      windowStart + WINDOW_MS - t,
      `pmxt local rate cap (${MAX_PER_WINDOW}/min) reached — skipping this call to protect the shared key`,
    );
  }
  windowCount += 1;
}

/**
 * Open the circuit after a server 429 — but ONLY when it carries an explicit `Retry-After` (the server
 * telling us how long to wait). A header-less 429 returns without pausing: it's treated as transient so
 * the next call recovers immediately, with the sliding-window cap as the standing backstop. The honored
 * delay is capped (`MAX_PAUSE_MS`) so a hostile/huge header can't blackout enrichment.
 */
function noteServer429(retryAfterHeader: string | null | undefined): void {
  const secs = retryAfterHeader != null ? Number(retryAfterHeader) : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return; // no explicit Retry-After → no blackout
  pausedUntil = Math.max(pausedUntil, httpNow() + Math.min(secs * 1000, MAX_PAUSE_MS));
}

/**
 * GET `url` with the pmxt bearer key and parse JSON. The key is sent as `Authorization: Bearer`
 * (pmxt's canonical scheme). Each attempt times out via AbortController (default 9s — raised from
 * 6s after live bursts tripped the old ceiling on responses that normally land <1s) so a slow
 * enrichment call can never hang a reply.
 *
 * Two RETRYABLE failure classes, each with its own small budget, both fail-soft:
 *   - a timeout `AbortError` / network `TypeError` → ONE retry (`retries`) after a short backoff;
 *   - a header-LESS `429` → up to `MAX_RATE_RETRIES` retries (verified live: pmxt's free tier emits
 *     fast transient burst `429`s that clear on the next call). A `429` WITH `Retry-After` is a real
 *     cooldown — non-retryable, and it arms the circuit breaker. Any OTHER HTTP status (4xx/5xx) is a
 *     definitive answer and is never retried. A still-failing venue throws to its caller → empty.
 */
export async function getJson<T>(
  url: string | URL,
  apiKey: string,
  timeoutMs = 9_000,
  retries = 1,
): Promise<T> {
  // Client-side rate guard: throws PmxtRateLimitError (fail-soft, no network) when over the local cap
  // or inside a post-429 pause. Reserved ONCE — the transient retries below reuse this slot.
  reserveSlot();
  let netAttempts = 0; // timeout / network retries used
  let rateAttempts = 0; // transient-429 retries used
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 429) {
          const ra = res.headers?.get?.("retry-after");
          // A Retry-After means a real cooldown → arm the breaker (pause everything) and DON'T retry.
          // A header-less 429 is a transient burst rejection → retryable (no pause; clears next call).
          noteServer429(ra);
          const hasCooldown = ra != null && Number.isFinite(Number(ra)) && Number(ra) > 0;
          throw new PmxtError(429, `GET ${redact(url)} → 429 ${res.statusText}`, !hasCooldown);
        }
        throw new PmxtError(res.status, `GET ${redact(url)} → ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof PmxtError) {
        // Transient (header-less) 429 → a few quick retries; the burst window passes almost at once.
        if (err.status === 429 && err.retryable && rateAttempts < MAX_RATE_RETRIES) {
          rateAttempts++;
          clearTimeout(timer);
          await sleep(rate429BackoffMs * rateAttempts);
          continue;
        }
        throw err; // definitive (non-429, a Retry-After cooldown, or 429 retries exhausted)
      }
      // Transient timeout abort / network error: one more try after a short backoff.
      if (netAttempts < retries) {
        netAttempts++;
        clearTimeout(timer);
        await sleep(retryBackoffMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Never let a key ride in an error string, even if a future caller puts it in the query. */
function redact(url: string | URL): string {
  const s = String(url);
  return s.replace(/(api[_-]?key|token|bearer)=[^&]*/gi, "$1=***");
}
