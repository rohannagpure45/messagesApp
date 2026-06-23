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
 * Cost control (PMXT_INTEGRATION §5): results are cached per (venue, query) with a TTL. The free
 * tier is 25k credits/mo @ 60 req/min — two cached GETs per search stays well within (a probe burst
 * can 429; the client treats that as just another fail-soft empty venue).
 */
import { getJson, PmxtError } from "./http";
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
  outcomes?: UnifiedOutcome[] | null;
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
}

interface CacheEntry {
  at: number;
  results: VenueResult[];
}

const CACHE_TTL_MS = 60_000; // 1 minute — fresh enough for live odds, cheap on credits.
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
 * The headline outcome: among the AFFIRMATIVE outcomes (so we show P(event happens), not "Not X"),
 * the highest-priced one — i.e. the favorite for a multi-candidate market, or the YES side of a
 * binary one. Falls back to the overall highest-priced outcome if every label looks negative.
 */
function headlineOutcome(outcomes: UnifiedOutcome[] | null | undefined): {
  label: string;
  price: number;
} | null {
  if (!outcomes || outcomes.length === 0) return null;
  const priced = outcomes.filter((o) => o.price != null && !Number.isNaN(o.price));
  if (priced.length === 0) return null;
  const affirmative = priced.filter((o) => !NEGATIVE_LABEL.test(o.label));
  const pool = affirmative.length > 0 ? affirmative : priced;
  let best = pool[0]!;
  for (const o of pool) if ((o.price ?? -1) > (best.price ?? -1)) best = o;
  return { label: best.label, price: best.price ?? 0 };
}

function toVenueResult(m: UnifiedMarket, label: string, query: string): VenueResult {
  const head = headlineOutcome(m.outcomes);
  const venue = (m.sourceExchange as Exclude<Venue, "sawa">) ?? label.toLowerCase();
  return {
    venue,
    sourceLabel: label,
    realMoney: true,
    title: m.title,
    url: m.url ?? undefined,
    imageUrl: m.image ?? undefined,
    volume24h: m.volume24h ?? m.volume ?? undefined,
    top: head ? { label: head.label, price: head.price } : undefined,
    relevance: scoreRelevance(m.title, query),
  };
}

/** Search one venue's open markets for `query`. Cached; throws PmxtError on an upstream failure. */
export async function searchVenue(
  cfg: PmxtConfig,
  venue: Exclude<Venue, "sawa">,
  label: string,
  query: string,
  limit = 6,
): Promise<VenueResult[]> {
  const key = cacheKey(venue, query);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.results;

  const url = new URL(`${cfg.baseUrl}/v0/markets`);
  url.searchParams.set("q", query); // verified: `q`, not `query`
  url.searchParams.set("sourceExchange", venue); // verified: filters by venue
  url.searchParams.set("closed", "false"); // open markets only
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 50))));

  const res = await getJson<MarketsResponse>(url, cfg.apiKey);
  const results = (res.data ?? []).map((m) => toVenueResult(m, label, query));
  cache.set(key, { at: now(), results });
  return results;
}

/**
 * Search Kalshi + Polymarket in parallel, fail-soft. A venue that errors (or pmxt being down / a
 * 429) yields an empty list for that venue and is logged — it never throws, so the Sawa reply
 * proceeds regardless.
 */
export async function searchExternal(
  cfg: PmxtConfig,
  query: string,
  limitPerVenue = 6,
): Promise<ExternalResults> {
  const settled = await Promise.allSettled(
    EXCHANGES.map((e) => searchVenue(cfg, e.venue, e.label, query, limitPerVenue)),
  );
  const out: ExternalResults = { kalshi: [], polymarket: [] };
  settled.forEach((r, i) => {
    const { venue } = EXCHANGES[i]!;
    if (r.status === "fulfilled") {
      out[venue] = r.value;
    } else {
      const reason = r.reason;
      const detail = reason instanceof PmxtError ? `${reason.status}` : "error";
      console.warn(`[pmxt] ${venue} search failed (${detail}) — degrading to without it.`);
    }
  });
  return out;
}

/** Test helper: clear the per-query cache between cases. */
export function __clearCache(): void {
  cache.clear();
}
