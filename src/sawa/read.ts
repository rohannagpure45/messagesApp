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
import fs from "node:fs";
import path from "node:path";
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

// --- Public-feed cache (durable + stale-while-revalidate) ------------------
// The feed GET (`/api/predictions?limit=100`) is QUERY-INDEPENDENT — `listMarkets` filters/ranks the
// rows client-side — so one cached page serves EVERY query (and /markets). Measured baseline: this
// GET is ~1.0s and was paid on every query (docs/imessage-market-cache-latency.md). Three layers:
//   • FRESH (< FEED_TTL_MS): serve directly.
//   • STALE (< FEED_STALE_MS): serve the cached page immediately AND refresh in the background
//     (stale-while-revalidate) — this is what makes a cold start "warm": after a restart the page is
//     rehydrated from disk (below) and the first query is served from it in ~ms while a refresh runs.
//   • older / absent: fetch synchronously.
// DURABLE: like the pmxt cache (src/pmxt/discover.ts) and settings.ts, the page is written through to
// a bot-local JSON file and rehydrated on startup, so a redeploy doesn't face an empty cache and a
// ~1s origin fetch on every first query. Off by default (unit tests stay purely in-memory).
interface FeedCacheEntry {
  at: number;
  res: FeedResponse;
}
const FEED_TTL_MS = 30_000; // fresh window — serve directly, no refresh
const FEED_STALE_MS = 10 * 60_000; // serve-stale ceiling — beyond this a cold entry is refetched synchronously
const feedCache = new Map<number, FeedCacheEntry>();
const feedRefreshing = new Set<number>();
/** Injectable clock for deterministic tests (mirrors src/pmxt/discover.ts). */
let now: () => number = () => Date.now();
/** The in-flight background revalidation (test seam — await it to observe the SWR refresh). */
let lastFeedRevalidation: Promise<void> | null = null;

interface FeedCacheSnapshot {
  [page: string]: FeedCacheEntry;
}
export interface FeedCachePersistence {
  load(): FeedCacheSnapshot | null;
  save(data: FeedCacheSnapshot): void;
}
let feedPersist: FeedCachePersistence | undefined;

function saveFeedCache(): void {
  if (!feedPersist) return;
  const out: FeedCacheSnapshot = {};
  for (const [k, v] of feedCache) out[String(k)] = v;
  feedPersist.save(out);
}

/** Enable durable persistence: rehydrate now (dropping entries past the stale ceiling), then write through. */
export function enableFeedCachePersistence(adapter: FeedCachePersistence): void {
  feedPersist = adapter;
  const snap = adapter.load();
  if (!snap) return;
  const t = now();
  for (const [k, v] of Object.entries(snap)) {
    if (v && typeof v.at === "number" && v.res && t - v.at < FEED_STALE_MS) feedCache.set(Number(k), v);
  }
}

/** File-backed persistence (atomic temp+rename, fail-soft) — mirrors fileSettingsPersistence in settings.ts. */
export function fileFeedCachePersistence(filePath: string): FeedCachePersistence {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as FeedCacheSnapshot;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn(`[feed] could not read cache ${filePath} (${(err as Error).message}) — starting cold.`);
        return null; // missing file on first run is normal
      }
    },
    save(data) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath); // atomic replace
      } catch (err) {
        console.warn(`[feed] could not persist cache ${filePath} (${(err as Error).message}) — kept in memory only.`);
      }
    },
  };
}

/** Test seam: set/clear the persistence adapter without hydrating (mirrors __setClock). */
export function __setFeedCachePersistence(p: FeedCachePersistence | null): void {
  feedPersist = p ?? undefined;
}
/** Test helper: override the cache clock. */
export function __setFeedClock(fn: () => number): void {
  now = fn;
}
/** Test/bench helper: clear the public-feed cache between cases. */
export function __clearFeedCache(): void {
  feedCache.clear();
  feedRefreshing.clear();
}
/** Test seam: await any in-flight stale-while-revalidate refresh. */
export async function __feedRevalidationSettled(): Promise<void> {
  await lastFeedRevalidation?.catch(() => {});
}

async function fetchFeedNetwork(cfg: Config, page: number): Promise<FeedResponse> {
  const url = apiUrl(cfg, "/api/predictions");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(FEED_PAGE_LIMIT));
  const res = await getJson<FeedResponse>(url);
  feedCache.set(page, { at: now(), res });
  saveFeedCache(); // write through so the cache survives a restart
  return res;
}

async function revalidateFeed(cfg: Config, page: number): Promise<void> {
  if (feedRefreshing.has(page)) return; // a refresh is already in flight for this page
  feedRefreshing.add(page);
  try {
    await fetchFeedNetwork(cfg, page);
  } catch (err) {
    console.warn(`[feed] background refresh of page ${page} failed (${(err as Error).message}) — keeping stale.`);
  } finally {
    feedRefreshing.delete(page);
  }
}

/**
 * One page of the public feed (newest first), `FEED_PAGE_LIMIT` rows. Fresh-serve under FEED_TTL_MS;
 * stale-serve + background refresh under FEED_STALE_MS (so a rehydrated cold start is instant); else
 * fetch synchronously.
 */
async function fetchFeedPage(cfg: Config, page: number): Promise<FeedResponse> {
  const hit = feedCache.get(page);
  const age = hit ? now() - hit.at : Infinity;
  if (hit && age < FEED_TTL_MS) return hit.res; // fresh
  if (hit && age < FEED_STALE_MS) {
    lastFeedRevalidation = revalidateFeed(cfg, page); // stale → serve now, refresh in background
    return hit.res;
  }
  return fetchFeedNetwork(cfg, page); // miss / too-old → synchronous
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
