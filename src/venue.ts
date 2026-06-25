/**
 * Cross-venue, presentation-neutral result shape for the SEARCH face.
 *
 * Every source — Sawa (virtual coins), Kalshi and Polymarket (real-money, via pmxt) — normalizes
 * into a `VenueResult`, so the Skyscanner card renders one compact line per source from a single
 * shape. The card decides how to render a line from `realMoney` (price ¢ + implied return for the
 * real-money venues; pool-share odds % for Sawa).
 */

export type Venue = "sawa" | "kalshi" | "polymarket";

/** The headline outcome shown on a one-line result (the option a user would scan first). */
export interface TopOutcome {
  label: string;
  /** Real-money venues: last price as a probability 0–1 (cost of one $1 contract). */
  price?: number;
  /** Sawa: display odds as a pool-share percentage (0–100), or null when the pool is empty. */
  oddsPct?: number | null;
}

export interface VenueResult {
  venue: Venue;
  /** Human label for the source line, e.g. "Sawa" / "Kalshi" / "Polymarket". */
  sourceLabel: string;
  /** True for Kalshi/Polymarket (real money), false for Sawa (virtual coins). Drives labeling. */
  realMoney: boolean;
  title: string;
  /** Tappable market URL (external venue url, or Sawa market page via the URL template). */
  url?: string;
  /** Cover image (used as a richlink fallback / future attachment); not always present. */
  imageUrl?: string;
  /** 24h volume — a secondary ranking signal. */
  volume24h?: number;
  /** The headline outcome to show on the one-liner. */
  top?: TopOutcome;
  /**
   * The second-place outcome, when one exists — lets the conversational reply show a folk-style
   * two-sided line ("Brazil 59%, Argentina 41%" / "Ronaldo 8¢, Messi 93¢"). Suppressed by the
   * renderer for Yes/No binaries (a "No" runner-up is just the complement). Optional everywhere.
   */
  runnerUp?: TopOutcome;
  /** Relevance score vs the query (token overlap, 0–1). Higher = better. */
  relevance: number;
  /**
   * When this market resolves, as epoch ms (pmxt `resolutionDate` / Sawa `deadline`). Drives the
   * recency ranking signal: upcoming-soonest first, already-resolved (past) last. Optional — markets
   * without a parseable date rank neutrally (neither boosted nor buried).
   */
  closesAt?: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "to", "for", "and", "or", "will", "is", "be",
  "who", "what", "when", "where", "which", "by", "at", "vs", "any",
]);

/** Split a string into lowercased alphanumeric tokens, dropping stopwords and 1-char tokens. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Relevance of a market `title` to a search `query`: the share of the query's content tokens that
 * appear in the title. Matching is TOKEN-BOUNDARY (whole title tokens), not substring — so the
 * short token "us" in "2026 US election" does NOT spuriously match "business". A query token of
 * length ≥ 5 may also match a title token by shared prefix (handles inflections like
 * "election"/"elections", "mayor"/"mayoral"). This is a fuzzy heuristic — it can over-match a longer
 * different word (e.g. "india"→"indiana"), an accepted precision trade-off for catching inflections.
 * Identical scoring across venues keeps the merged ranking fair.
 */
export function scoreRelevance(title: string, query: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const titleTokens = new Set(tokenize(title));
  let hits = 0;
  for (const tok of q) {
    if (titleTokens.has(tok)) {
      hits++;
      continue;
    }
    for (const x of titleTokens) {
      if (Math.min(tok.length, x.length) >= 5 && (x.startsWith(tok) || tok.startsWith(x))) {
        hits++;
        break;
      }
    }
  }
  return hits / q.length;
}
