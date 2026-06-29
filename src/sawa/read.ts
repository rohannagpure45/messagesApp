/**
 * Sawa market reads via the web app's PUBLIC GET endpoints — GET only (Option C).
 *
 * The bot holds NO database credentials. It reads the same public-feed endpoints the
 * Sawa web app exposes (no JWT), which enforce the private-market guard server-side:
 *   GET /api/predictions            — public feed (isPrivate=false, isHidden=false)
 *   GET /api/predictions/[id]       — one market's detail (401/403/404 for private/hidden/missing)
 *   GET /api/predictions/[id]/odds  — per-option pool sums
 *   GET /api/predictions/trending   — public ranked feed
 *
 * Display odds are computed from each option's parimutuel pool volume (option pool ÷ total
 * pool). Per decision #2 we NEVER recompute payout — these percentages are display-only.
 * `resolved` markets are filtered out client-side (the feed includes them).
 *
 * PII guardrail: only public market fields are ever read/surfaced. The `User` table and
 * email/phone/password/googleId are never queried; we touch only the public
 * `creator.username` the feed already exposes, and never surface it.
 *
 * Search note: the app exposes no server-side text-search param, so `listMarkets({ search })`
 * matches titles client-side over the (small) public feed — see docs/BUILD_PLAN.md §4.
 */
import { getJson, UpstreamError } from "./http";
import type { Config } from "./config";
import type { Market, Outcome } from "./types";

/** API hard cap on `?limit` (the Sawa app clamps it to 100). */
const FEED_PAGE_LIMIT = 100;
/** Safety bound on how much of the feed we scan for client-side title search. */
const MAX_SCAN_PAGES = 3;

interface RawOption {
  id: string;
  label: string;
  /** Per-option parimutuel pool: the feed/trending routes attach `bets: [{ amount }]`. */
  bets?: { amount: number }[];
}

/** The fields we read from a `GET /api/predictions` or `/trending` row. */
interface RawFeedPrediction {
  id: string;
  title: string;
  category: string | null;
  deadline: string;
  resolved: boolean;
  isPrivate?: boolean;
  isHidden?: boolean;
  options: RawOption[];
  /** Total parimutuel pool across all options. */
  volume?: number;
}

interface FeedResponse {
  predictions: RawFeedPrediction[];
  pagination?: { page: number; limit: number; total: number; pages: number };
}

interface DetailResponse {
  prediction: RawFeedPrediction;
}

interface OddsResponse {
  odds: { id: string; total: number }[];
  totalPool: number;
  resolved: boolean;
}

interface TrendingResponse {
  predictions: RawFeedPrediction[];
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(Math.trunc(n), 50));
}

function apiUrl(cfg: Config, path: string): URL {
  return new URL(`${cfg.apiBaseUrl}${path}`);
}

function marketUrl(cfg: Config, id: string): string | undefined {
  return cfg.marketUrlTemplate ? cfg.marketUrlTemplate.replace("{id}", id) : undefined;
}

/**
 * Keep only open (not resolved) public markets. On the feed/trending paths the server already
 * excludes private/hidden and omits the `isHidden` field, so there `!resolved` (plus the live
 * `isPrivate` field) is the operative client-side guard; on the detail path (`getMarket`) the full
 * row carries `isPrivate`/`isHidden`, so all three checks are live. Defensive in every case.
 */
function isOpenPublic(p: RawFeedPrediction): boolean {
  return !p.resolved && p.isPrivate !== true && p.isHidden !== true;
}

/** Display odds = each option's pool share of the total volume (parimutuel; null when the pool is empty). */
function outcomesFromPools(options: RawOption[], totalVolume: number): Outcome[] {
  return options.map((o) => {
    const pool = o.bets?.[0]?.amount ?? 0;
    return { label: o.label, oddsPct: totalVolume > 0 ? (pool / totalVolume) * 100 : null };
  });
}

function feedToMarket(cfg: Config, p: RawFeedPrediction): Market {
  return {
    venue: "sawa",
    ref: `sawa:${p.id}`,
    id: p.id,
    title: p.title,
    category: p.category ?? undefined,
    deadline: p.deadline,
    resolved: p.resolved,
    outcomes: outcomesFromPools(p.options ?? [], p.volume ?? 0),
    url: marketUrl(cfg, p.id),
  };
}

export interface ListOptions {
  search?: string;
  limit?: number;
}

/**
 * List open, public markets (newest first), optionally filtered by a client-side title search.
 *
 * The app has no server-side text-search param, so `search` matches titles locally over the
 * public feed. We page the feed and filter as we go — keeping only open+public (and matching)
 * markets — until we have `want` of them or run out of pages / hit the `MAX_SCAN_PAGES` scan
 * ceiling. Filtering during paging (not after) means a page dominated by resolved markets does
 * not under-fill the result. The feed is small today (~open catalog ≪ one page), so this is
 * typically a single request; the cap bounds the worst case.
 */
export async function listMarkets(cfg: Config, opts: ListOptions = {}): Promise<Market[]> {
  const { search, limit = 10 } = opts;
  const want = clampLimit(limit);
  const needle = search?.toLowerCase();

  const matches: Market[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fetchFeedPage(cfg, page);
    pages = res.pagination?.pages ?? 1;
    for (const p of res.predictions ?? []) {
      if (!isOpenPublic(p)) continue;
      if (needle && !p.title.toLowerCase().includes(needle)) continue;
      matches.push(feedToMarket(cfg, p));
      if (matches.length >= want) return matches;
    }
    page += 1;
  } while (page <= pages && page <= MAX_SCAN_PAGES);
  return matches;
}

// --- Public-feed cache -----------------------------------------------------
// The feed GET (`/api/predictions?limit=100`) is QUERY-INDEPENDENT — `listMarkets` filters and
// ranks the returned rows client-side — so one cached page serves EVERY query (and the /markets
// command) for the TTL window. Measured baseline: this GET is ~1.0s and was paid on every query;
// caching it removes that floor on warm/repeat traffic (docs/imessage-market-cache-latency.md).
// Short TTL: the public catalog only changes when a market is created/resolved, and `resolved`
// is already filtered client-side, so a few seconds' staleness is harmless for discovery.
interface FeedCacheEntry {
  at: number;
  res: FeedResponse;
}
const FEED_CACHE_TTL_MS = 30_000;
const feedCache = new Map<number, FeedCacheEntry>();
/** Injectable clock for deterministic tests (mirrors src/pmxt/discover.ts). */
let now: () => number = () => Date.now();
/** Test helper: override the cache clock. */
export function __setFeedClock(fn: () => number): void {
  now = fn;
}
/** Test/bench helper: clear the public-feed cache between cases. */
export function __clearFeedCache(): void {
  feedCache.clear();
}

/** One page of the public feed (newest first), `FEED_PAGE_LIMIT` rows. Cached for `FEED_CACHE_TTL_MS`. */
async function fetchFeedPage(cfg: Config, page: number): Promise<FeedResponse> {
  const hit = feedCache.get(page);
  if (hit && now() - hit.at < FEED_CACHE_TTL_MS) return hit.res;
  const url = apiUrl(cfg, "/api/predictions");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(FEED_PAGE_LIMIT));
  const res = await getJson<FeedResponse>(url);
  feedCache.set(page, { at: now(), res });
  return res;
}

/** Fetch a single public market by id, with current odds. Private/hidden/missing → null. */
export async function getMarket(cfg: Config, id: string): Promise<Market | null> {
  const detail = await getDetailOrNull(cfg, id);
  if (!detail || !isOpenPublic(detail)) return null;

  const odds = await getOddsByOption(cfg, id);
  const outcomes: Outcome[] = (detail.options ?? []).map((o) => ({
    label: o.label,
    oddsPct: odds.get(o.id) ?? null,
  }));
  return {
    venue: "sawa",
    ref: `sawa:${detail.id}`,
    id: detail.id,
    title: detail.title,
    category: detail.category ?? undefined,
    deadline: detail.deadline,
    resolved: detail.resolved,
    outcomes,
    url: marketUrl(cfg, detail.id),
  };
}

async function getDetailOrNull(cfg: Config, id: string): Promise<RawFeedPrediction | null> {
  try {
    const res = await getJson<DetailResponse>(apiUrl(cfg, `/api/predictions/${encodeURIComponent(id)}`));
    return res.prediction ?? null;
  } catch (err) {
    // 401/403 (private / needs-access) and 404 (missing) all mean "no public market" → null.
    if (err instanceof UpstreamError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

/** Map optionId → display-odds percentage from per-option pool sums. Fail-soft to empty (odds unknown). */
async function getOddsByOption(cfg: Config, id: string): Promise<Map<string, number>> {
  try {
    const res = await getJson<OddsResponse>(apiUrl(cfg, `/api/predictions/${encodeURIComponent(id)}/odds`));
    const out = new Map<string, number>();
    if (res.totalPool > 0) {
      for (const o of res.odds) out.set(o.id, (o.total / res.totalPool) * 100);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Public ranked "trending" feed (open + public), ordered by the app's own ranking. */
export async function getTrending(cfg: Config, limit = 10): Promise<Market[]> {
  const want = clampLimit(limit);
  const url = apiUrl(cfg, "/api/predictions/trending");
  url.searchParams.set("limit", String(want));
  const res = await getJson<TrendingResponse>(url);
  return (res.predictions ?? []).filter(isOpenPublic).slice(0, want).map((p) => feedToMarket(cfg, p));
}
