/**
 * Cross-venue SEARCH aggregator — the engine behind the default face.
 *
 * Merges three sources into one ranked, capped result set:
 *   - Sawa (virtual coins) via the public app API (`read.ts`, Option C). Because the Sawa feed has
 *     no server-side text search, we pull the (small) open feed and rank it by TOKEN-OVERLAP
 *     relevance here — substring matching is too strict ("FIFA World Cup" must still match a market
 *     titled "Who wins the World Cup?").
 *   - Kalshi + Polymarket (real money) via pmxt (`discover.ts`), per-exchange so each line's source
 *     is exact.
 *
 * Fail-soft: pmxt being absent or erroring yields no external rows but never blocks the Sawa half.
 */
import { listMarkets } from "./sawa/read";
import { searchExternal } from "./pmxt/discover";
import type { Config, PmxtConfig } from "./sawa/config";
import type { Market, Outcome } from "./sawa/types";
import { type Venue, type VenueResult, scoreRelevance, tokenize } from "./venue";

/** How many open Sawa markets to pull for client-side ranking (the live open catalog is small). */
const SAWA_FEED_LIMIT = 50;
/** Minimum token-overlap relevance to include a result (≥ ~1/3 of the query's tokens present). */
const RELEVANCE_MIN = 0.34;
/** Max rows shown per source (Skyscanner-style: a few options each, not a wall). */
const PER_SOURCE_CAP = 3;
/**
 * Markets per venue to ask pmxt for, then re-ranked + capped locally. Generous because a single
 * event (e.g. "World Cup Winner") explodes into one per-team market; a small fetch would miss the
 * favorites, so we pull a wider slice and let the favorite-first ranking surface Brazil/Argentina.
 */
const PMXT_LIMIT_PER_VENUE = 20;

export interface SearchResults {
  query: string;
  sawa: VenueResult[];
  kalshi: VenueResult[];
  polymarket: VenueResult[];
  /** True when no source returned a usable match. */
  empty: boolean;
  /** True when at least one source had more matches than the per-source cap (offer "narrow it down"). */
  truncated: boolean;
  /** True when pmxt enrichment was unavailable (no key) — the reply is Sawa-only by design. */
  externalUnavailable: boolean;
}

/**
 * Pick the headline + runner-up Sawa outcomes: the two highest display-odds options (the current
 * favorite, then the next). The runner-up powers the conversational reply's folk-style two-sided
 * line; the renderer drops it for Yes/No binaries.
 */
function pickSawaOutcomes(outcomes: Outcome[]): { top?: VenueResult["top"]; runnerUp?: VenueResult["runnerUp"] } {
  if (outcomes.length === 0) return {};
  const sorted = [...outcomes].sort((a, b) => (b.oddsPct ?? -1) - (a.oddsPct ?? -1));
  const top = sorted[0]!;
  const second = sorted[1];
  return {
    top: { label: top.label, oddsPct: top.oddsPct },
    runnerUp: second ? { label: second.label, oddsPct: second.oddsPct } : undefined,
  };
}

function sawaToVenueResult(m: Market, query: string): VenueResult {
  const { top, runnerUp } = pickSawaOutcomes(m.outcomes);
  return {
    venue: "sawa",
    sourceLabel: "Sawa",
    realMoney: false,
    title: m.title,
    url: m.url,
    top,
    runnerUp,
    relevance: scoreRelevance(m.title, query),
  };
}

/** Above this probability an outcome is a near-lock — settled, and boring to surface. */
const NEAR_LOCK = 0.92;

/**
 * "Interestingness" of a row's headline outcome (0–1), the primary ranking signal after relevance.
 *
 * It is the outcome's probability (external price 0–1, or Sawa favorite odds) — so a real favorite
 * (Brazil 22¢) beats a longshot (Congo DR <1¢) — BUT probabilities above the near-lock knee are
 * folded back down via their complement, because a 99¢ near-certainty ("Labour 99¢", an announcer
 * prop) is as uninteresting to show as a 1¢ longshot. Net effect: competitive favorites win
 * (Spain 14¢ for the World Cup, Karen Bass 65¢ for a mayoral race), while both locks and longshots
 * sink. 24h volume is the tiebreak.
 */
export function interest(r: VenueResult): number {
  const p = r.top?.price ?? (r.top?.oddsPct != null ? r.top.oddsPct / 100 : null);
  if (p == null || p <= 0) return 0;
  return p < NEAR_LOCK ? p : Math.max(0, 1 - p);
}

/**
 * Relevance margin an external market must beat the best Sawa match by before it is allowed to lead
 * the single conversational answer. Sawa is the only venue users can act on (and the referral/
 * distribution surface), so we bias toward it — but never bury a clearly-more-relevant external
 * market. 0.2 ≈ "one more matched query token out of five." Owner-tunable.
 */
const SAWA_LEAD_EPSILON = 0.2;

/**
 * Flatten the per-venue results into ONE cross-venue ranked list — the source for the conversational
 * reply (index 0 = the market shown first) and the follow-up cursor (`not that` pages forward).
 *
 * Base order is identical to the per-venue ranking — relevance desc, then the same `interest()`
 * signal, then 24h volume — so the merge is fair. THEN the Sawa-lead tiebreak (owner decision): if a
 * relevant Sawa market exists it leads UNLESS an external market beats the best Sawa match's
 * relevance by more than `SAWA_LEAD_EPSILON`, in which case the clearly-more-relevant external
 * market leads. The remaining markets keep relevance/interest order so paging stays sensible.
 */
export function flattenRanked(results: SearchResults): VenueResult[] {
  const ranked = [...results.sawa, ...results.kalshi, ...results.polymarket].sort(
    (a, b) => b.relevance - a.relevance || interest(b) - interest(a) || (b.volume24h ?? 0) - (a.volume24h ?? 0),
  );
  if (ranked.length === 0) return ranked;
  const lead = pickLead(ranked);
  if (lead === ranked[0]) return ranked;
  return [lead, ...ranked.filter((r) => r !== lead)];
}

/** Pick the leading market: the best Sawa match unless an external one is *clearly* more relevant. */
function pickLead(ranked: VenueResult[]): VenueResult {
  const top = ranked[0]!;
  if (top.venue === "sawa") return top;
  const bestSawa = ranked.find((r) => r.venue === "sawa");
  if (!bestSawa) return top; // no Sawa match → the most-relevant external market leads
  return top.relevance - bestSawa.relevance > SAWA_LEAD_EPSILON ? top : bestSawa;
}

/** The venues that returned ≥1 row — carried into conversation state so link follow-ups know what exists. */
export function venuesPresent(results: SearchResults): Venue[] {
  const out: Venue[] = [];
  if (results.sawa.length) out.push("sawa");
  if (results.kalshi.length) out.push("kalshi");
  if (results.polymarket.length) out.push("polymarket");
  return out;
}

/** Rank by relevance desc, then interest desc, then 24h volume desc; floor + cap. */
function rankAndCap(results: VenueResult[]): { rows: VenueResult[]; truncated: boolean } {
  const kept = results
    .filter((r) => r.relevance >= RELEVANCE_MIN)
    .sort(
      (a, b) =>
        b.relevance - a.relevance || interest(b) - interest(a) || (b.volume24h ?? 0) - (a.volume24h ?? 0),
    );
  return { rows: kept.slice(0, PER_SOURCE_CAP), truncated: kept.length > PER_SOURCE_CAP };
}

/** Fetch + rank the Sawa side. Fail-soft is the caller's job (this throws on an upstream read error). */
async function searchSawa(cfg: Config, query: string): Promise<{ rows: VenueResult[]; truncated: boolean }> {
  const markets = await listMarkets(cfg, { limit: SAWA_FEED_LIMIT });
  return rankAndCap(markets.map((m) => sawaToVenueResult(m, query)));
}

/**
 * Run a cross-venue search for `query`. The Sawa read and the pmxt enrichment run concurrently;
 * each is independently fail-soft so one source's outage can't sink the other.
 */
export async function runSearch(
  query: string,
  opts: { config: Config; pmxt: PmxtConfig | null },
): Promise<SearchResults> {
  const q = query.trim();
  const externalUnavailable = opts.pmxt === null;

  const [sawaSettled, externalSettled] = await Promise.allSettled([
    searchSawa(opts.config, q),
    opts.pmxt ? searchExternal(opts.pmxt, q, PMXT_LIMIT_PER_VENUE) : Promise.resolve(null),
  ]);

  let sawa: VenueResult[] = [];
  let truncated = false;
  if (sawaSettled.status === "fulfilled") {
    sawa = sawaSettled.value.rows;
    truncated ||= sawaSettled.value.truncated;
  } else {
    console.warn(`[search] Sawa read failed: ${(sawaSettled.reason as Error)?.message}`);
  }

  let kalshi: VenueResult[] = [];
  let polymarket: VenueResult[] = [];
  if (externalSettled.status === "fulfilled" && externalSettled.value) {
    const k = rankAndCap(externalSettled.value.kalshi);
    const p = rankAndCap(externalSettled.value.polymarket);
    kalshi = k.rows;
    polymarket = p.rows;
    truncated ||= k.truncated || p.truncated;
  } else if (externalSettled.status === "rejected") {
    console.warn(`[search] external enrichment failed: ${(externalSettled.reason as Error)?.message}`);
  }

  return {
    query: q,
    sawa,
    kalshi,
    polymarket,
    empty: sawa.length === 0 && kalshi.length === 0 && polymarket.length === 0,
    truncated,
    externalUnavailable,
  };
}

/** Is this query likely too broad to be useful? (one short, common token). Used for gentle nudges. */
export function isBroadQuery(query: string): boolean {
  const toks = tokenize(query);
  return toks.length === 0 || (toks.length === 1 && toks[0]!.length <= 4);
}
