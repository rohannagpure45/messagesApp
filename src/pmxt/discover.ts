/**
 * pmxt cross-venue discovery — the "Kalshi + Polymarket" half of SEARCH.
 *
 * GET-only, fail-soft, cached. We query pmxt's catalog ONE VENUE AT A TIME
 * (`GET /v0/markets?sourceExchange=kalshi|polymarket&q=…`) so every row's source is known exactly
 * — the unified row carries the venue in `sourceExchange`, and the filter param name matches it.
 * (Verified live: `q` is the text-search param — NOT `query` — and `sourceExchange` is the venue
 * filter; the older `query`/`exchange` names are silently ignored.) Betting stays 100% on Sawa;
 * pmxt is read-only enrichment and a pmxt error/timeout must NEVER block the Sawa reply.
 *
 * Cost control (PMXT_INTEGRATION §5): the free tier is 25k credits/mo @ 60 req/min — bursting a whole
 * entity-decomposition fan-out at once is what tripped `429` live. We bound calls three ways: a per
 * (venue, query) cache, a STAGED fan-out (full query first; entities only if it found nothing), and a
 * concurrency cap. A 429/timeout is fail-soft (an empty venue) and flagged via `errored`.
 */
import { getJson, PmxtError, PmxtRateLimitError } from "./http";
import type { PmxtConfig } from "../sawa/config";
import { type Venue, type VenueResult, scoreRelevance } from "../venue";

/** A pmxt UnifiedOutcome (subset we read). `price` is a 0–1 probability for binary venues. */
interface UnifiedOutcome {
  outcomeId?: string;
  label: string;
  price: number | null;
}

/** A pmxt UnifiedMarket (subset we read) from `GET /v0/markets`. */
interface UnifiedMarket {
  marketId: string;
  /** Venue id, e.g. "kalshi" | "polymarket" | "probable" (the param name matches this field). */
  sourceExchange?: string | null;
  title: string;
  url?: string | null;
  image?: string | null;
  volume?: number | null;
  volume24h?: number | null;
  status?: string | null;
  /** ISO timestamp when the market resolves — drives the recency ranking signal. */
  resolutionDate?: string | null;
  outcomes?: UnifiedOutcome[] | null;
}

/** Parse an ISO date string to epoch ms, or undefined if absent/unparseable. */
function parseCloseDate(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

interface MarketsResponse {
  data?: UnifiedMarket[];
  meta?: { count: number; limit: number; offset: number };
}

/** The two real-money venues we surface, with their display labels. */
const EXCHANGES: { venue: Exclude<Venue, "sawa">; label: string }[] = [
  { venue: "kalshi", label: "Kalshi" },
  { venue: "polymarket", label: "Polymarket" },
];

export interface ExternalResults {
  kalshi: VenueResult[];
  polymarket: VenueResult[];
  /** True when ≥1 venue lookup ERRORED (429 rate-limit / timeout / network) — lets the caller tell
   *  "nothing matched" apart from "couldn't check", so the reply doesn't claim a market is absent
   *  when pmxt was merely rate-limited. */
  errored: boolean;
}

interface CacheEntry {
  at: number;
  results: VenueResult[];
}

// 3 minutes — discovery names a favorite, not a tradable quote, so slightly-staler odds are fine, and a
// longer TTL means a re-asked topic (common in live testing) reuses the cached rows instead of spending
// fresh calls/credits. Works WITH the client-side rate guard (src/pmxt/http.ts) to keep us under 60/min.
const CACHE_TTL_MS = 180_000;
const cache = new Map<string, CacheEntry>();
/** Injectable clock so tests are deterministic (avoids Date.now() flakiness). */
let now: () => number = () => Date.now();
export function __setClock(fn: () => number): void {
  now = fn;
}

function cacheKey(venue: string, query: string): string {
  return `${venue}::${query.trim().toLowerCase()}`;
}

/** Labels for the "No"/"Not" side of a binary market — never the headline we want to show. */
const NEGATIVE_LABEL = /^(no|not)\b/i;

/**
 * The headline + runner-up outcomes: among the AFFIRMATIVE outcomes (so we show P(event happens),
 * not "Not X"), the two highest-priced — i.e. the favorite then the next contender for a
 * multi-candidate market, or just the YES side of a binary one (a binary's only affirmative outcome
 * leaves no runner-up, so Yes/No markets stay single-sided). Falls back to the overall priced
 * outcomes if every label looks negative. The runner-up feeds the conversational two-sided line.
 */
function headlineOutcomes(outcomes: UnifiedOutcome[] | null | undefined): {
  top: { label: string; price: number };
  runnerUp?: { label: string; price: number };
} | null {
  if (!outcomes || outcomes.length === 0) return null;
  const priced = outcomes.filter((o) => o.price != null && !Number.isNaN(o.price));
  if (priced.length === 0) return null;
  const affirmative = priced.filter((o) => !NEGATIVE_LABEL.test(o.label));
  const pool = affirmative.length > 0 ? affirmative : priced;
  const sorted = [...pool].sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  const top = sorted[0]!;
  const second = sorted[1];
  return {
    top: { label: top.label, price: top.price ?? 0 },
    runnerUp: second ? { label: second.label, price: second.price ?? 0 } : undefined,
  };
}

function toVenueResult(m: UnifiedMarket, label: string, relevanceQuery: string): VenueResult {
  const head = headlineOutcomes(m.outcomes);
  const venue = (m.sourceExchange as Exclude<Venue, "sawa">) ?? label.toLowerCase();
  return {
    venue,
    sourceLabel: label,
    realMoney: true,
    title: m.title,
    url: m.url ?? undefined,
    imageUrl: m.image ?? undefined,
    volume24h: m.volume24h ?? m.volume ?? undefined,
    top: head ? { label: head.top.label, price: head.top.price } : undefined,
    runnerUp: head?.runnerUp ? { label: head.runnerUp.label, price: head.runnerUp.price } : undefined,
    relevance: scoreRelevance(m.title, relevanceQuery),
    closesAt: parseCloseDate(m.resolutionDate),
  };
}

/**
 * Search one venue's open markets for `query`. Cached; throws PmxtError on an upstream failure.
 *
 * `relevanceQuery` (defaults to `query`) is what rows are scored against — NOT necessarily the
 * fetch term. `searchExternal` passes the ORIGINAL user query here while fetching with a narrower
 * entity sub-query, so a row found via a decomposed sub-query (`"Cup"`) is still ranked against the
 * user's full intent (`"FIFA World Cup"`); the `RELEVANCE_MIN` floor in search.ts then drops
 * decomposition noise (`"Stanley Cup"` scores 1/3 < floor) while keeping the real entity market.
 */
export async function searchVenue(
  cfg: PmxtConfig,
  venue: Exclude<Venue, "sawa">,
  label: string,
  query: string,
  limit = 6,
  relevanceQuery: string = query,
): Promise<VenueResult[]> {
  const key = cacheKey(venue, query);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return rescore(hit.results, relevanceQuery);

  const url = new URL(`${cfg.baseUrl}/v0/markets`);
  url.searchParams.set("q", query); // verified: `q`, not `query`
  url.searchParams.set("sourceExchange", venue); // verified: filters by venue
  url.searchParams.set("closed", "false"); // open markets only
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 50))));

  const res = await getJson<MarketsResponse>(url, cfg.apiKey);
  const results = (res.data ?? []).map((m) => toVenueResult(m, label, relevanceQuery));
  cache.set(key, { at: now(), results });
  return results;
}

/**
 * Re-score cached rows against `relevanceQuery`. The cache is keyed by (venue, fetch-query) but the
 * SAME fetch sub-query can be reached from different original queries, so relevance (which depends
 * on the original) must be recomputed on a cache hit rather than served stale.
 */
function rescore(rows: VenueResult[], relevanceQuery: string): VenueResult[] {
  return rows.map((r) => ({ ...r, relevance: scoreRelevance(r.title, relevanceQuery) }));
}

/** Cap on distinct sub-queries per venue (full query + entities) — bounds API calls/credits. */
const MAX_SUBQUERIES = 6;

/** A "Capitalized" or ALL-CAPS word (e.g. "Mexico", "Jimenez", "FIFA", "BTC") — a proper-noun token. */
const PROPER_WORD = /^[A-Z][\w''-]*$/;

/**
 * Maximal runs of consecutive proper-noun words in `query` (e.g. "Mexico Raul Jimenez player props"
 * → ["Mexico Raul Jimenez"]; "Switzerland vs Canada" → ["Switzerland", "Canada"], since lowercase
 * "vs" breaks the run). Lowercase tails like "player props"/"goals"/"odds" are naturally excluded —
 * they are not proper nouns. These spans are the entities a compound query is really about.
 */
function properNounSpans(query: string): string[] {
  const spans: string[] = [];
  let run: string[] = [];
  for (const tok of query.split(/\s+/)) {
    if (PROPER_WORD.test(tok)) {
      run.push(tok);
    } else {
      if (run.length) spans.push(run.join(" "));
      run = [];
    }
  }
  if (run.length) spans.push(run.join(" "));
  return spans;
}

/**
 * Expand a query into the sub-queries to actually search pmxt with. pmxt's `q` is a phrase/title
 * match, so a compound natural-language query ("Mexico Raul Jimenez player props", "Switzerland,
 * India") matches NOTHING even though each entity has its own market — verified live. We therefore
 * emit, in priority order (deduped, capped):
 *   1. the FULL query (genuine phrases like "FIFA World Cup" still match a single title);
 *   2. list-separator entities (comma / semicolon / slash / ampersand / " and ");
 *   3. proper-noun entities — individual Capitalized words, then adjacent Capitalized bigrams, then
 *      the whole multi-word span — so "Mexico Raul Jimenez" reaches "Raul Jimenez" (the entity that
 *      actually has a market). Words come before bigrams so single entities survive the cap.
 * Relevance for every row is scored against the ORIGINAL query (see `searchVenue`), so a broad
 * decomposition (e.g. "Cup") never leaks noise past the `RELEVANCE_MIN` floor. Single proper nouns
 * and plain lowercase queries ("world cup") reduce to just the original — unchanged.
 */
export function expandQueries(query: string): string[] {
  const full = query.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    const t = q.trim();
    const k = t.toLowerCase();
    if (t.length >= 2 && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };

  add(full);
  // 2. List-separator entities.
  for (const part of full.split(/\s*(?:,|;|\/|&|\band\b)\s*/i)) add(part);
  // 3. Proper-noun entities: words first (cheap, high-value), then bigrams, then the whole span.
  const spans = properNounSpans(full);
  const words: string[] = [];
  const bigrams: string[] = [];
  for (const span of spans) {
    const toks = span.split(/\s+/);
    if (toks.length === 1) {
      words.push(span);
      continue;
    }
    for (const w of toks) words.push(w);
    for (let i = 0; i + 1 < toks.length; i++) bigrams.push(`${toks[i]} ${toks[i + 1]}`);
  }
  for (const w of words) add(w);
  for (const b of bigrams) add(b);
  for (const span of spans) if (span.includes(" ")) add(span);

  return out.slice(0, MAX_SUBQUERIES);
}

/**
 * Cap on concurrent pmxt requests. The free tier is 60 req/min and rejects bursts with `429`; firing a
 * whole fan-out at once (an entity-decomposed query is up to MAX_SUBQUERIES × 2 venues) is exactly what
 * tripped it in the live test. A small cap smooths the burst — excess calls queue behind it.
 */
const PMXT_CONCURRENCY = 4;

/** Run thunks with a concurrency cap, returning settled results IN ORDER (never throws). */
async function runLimited<T>(thunks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(thunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < thunks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await thunks[i]!() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return results;
}

interface Accumulator {
  out: { kalshi: VenueResult[]; polymarket: VenueResult[] };
  seen: { kalshi: Set<string>; polymarket: Set<string> };
}

/**
 * Run `subqueries` across both venues (concurrency-capped), merging + de-duping per venue into `acc`.
 * Returns whether any slice ERRORED, so the caller can surface "couldn't check" vs "nothing matched".
 */
async function searchSubqueries(
  cfg: PmxtConfig,
  subqueries: string[],
  originalQuery: string,
  limitPerVenue: number,
  acc: Accumulator,
): Promise<boolean> {
  const tasks = EXCHANGES.flatMap((e) => subqueries.map((q) => ({ e, q })));
  const settled = await runLimited(
    // Fetch with the (narrow) sub-query, but score relevance against the ORIGINAL query.
    tasks.map(({ e, q }) => () => searchVenue(cfg, e.venue, e.label, q, limitPerVenue, originalQuery)),
    PMXT_CONCURRENCY,
  );
  let errored = false;
  settled.forEach((r, i) => {
    const { e, q } = tasks[i]!;
    if (r.status === "fulfilled") {
      for (const row of r.value) {
        const dedupeKey = `${row.title} ${row.url ?? ""}`.toLowerCase();
        if (!acc.seen[e.venue].has(dedupeKey)) {
          acc.seen[e.venue].add(dedupeKey);
          acc.out[e.venue].push(row);
        }
      }
    } else {
      errored = true;
      // Distinguish the failure class: our client-side rate guard (no call made), a real HTTP status
      // (definitive), a timeout, or a network error — so the logs disambiguate a self-imposed skip
      // ("rate-capped (local)") from an actual server 429 ("HTTP 429").
      const reason = r.reason as Error | undefined;
      const detail =
        r.reason instanceof PmxtRateLimitError
          ? "rate-capped (local)"
          : r.reason instanceof PmxtError
            ? `HTTP ${r.reason.status}`
            : reason?.name === "AbortError"
              ? "timeout"
              : "network";
      console.warn(`[pmxt] ${e.venue} search "${q}" failed (${detail}) — degrading to without it.`);
    }
  });
  return errored;
}

/**
 * Search Kalshi + Polymarket, fail-soft, in TWO STAGES to bound credits and avoid `429`s:
 *   1. the FULL query on both venues (2 calls) — most queries ("bitcoin", "world cup") resolve here;
 *   2. ONLY if stage 1 found nothing, fan out to the entity sub-queries (`expandQueries`) so a
 *      compound that matches no single title ("Mexico Raul Jimenez player props") still reaches its
 *      entity. This cuts the typical search from up to 12 calls to 2.
 * A venue/sub-query that errors (a 429 / timeout) yields nothing for that slice, is logged, and sets
 * `errored` — it never throws, so the Sawa reply proceeds regardless.
 */
export async function searchExternal(
  cfg: PmxtConfig,
  query: string,
  limitPerVenue = 6,
): Promise<ExternalResults> {
  const full = query.trim();
  const acc: Accumulator = {
    out: { kalshi: [], polymarket: [] },
    seen: { kalshi: new Set(), polymarket: new Set() },
  };

  // Stage 1: the full query (cheap — 2 calls). Stage 2: entities, ONLY when stage 1 came back empty.
  let errored = await searchSubqueries(cfg, [full], query, limitPerVenue, acc);
  const stage1Empty = acc.out.kalshi.length === 0 && acc.out.polymarket.length === 0;
  if (stage1Empty) {
    const entities = expandQueries(query).filter((q) => q.toLowerCase() !== full.toLowerCase());
    if (entities.length) {
      errored = (await searchSubqueries(cfg, entities, query, limitPerVenue, acc)) || errored;
    }
  }

  return { kalshi: acc.out.kalshi, polymarket: acc.out.polymarket, errored };
}

/** Test helper: clear the per-query cache between cases. */
export function __clearCache(): void {
  cache.clear();
}
