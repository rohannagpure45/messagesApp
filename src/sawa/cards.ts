/**
 * Presentation layer for the SEARCH face — the "Skyscanner card."
 *
 * Pure string builders (like format.ts): the router wraps the output in Spectrum's `markdown()` /
 * `richlink()` so this stays trivially unit-testable and platform-neutral. Follows the BUILD_PLAN
 * §2.1 UX principles: bubble-sized, one compact line per market, price-first, real-money venues
 * clearly distinguished from Sawa virtual coins, the disclaimer on every coin/market message.
 */
import type { SearchResults } from "../search";
import type { VenueResult } from "../venue";

export const DISCLAIMER = "Virtual Sawa coins — entertainment only, no cash value.";
/** Explains both payout models so "price + payout per source" is unambiguous. */
const FOOTER =
  "🪙 Sawa = virtual coins (parimutuel — payout set at resolution).  " +
  "📈 Kalshi/Polymarket = real money (price = cost of a $1 contract; the ×N is your return if it hits).  " +
  DISCLAIMER;

const TITLE_MAX = 52;

function truncate(s: string, max = TITLE_MAX): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

interface PriceDisplay {
  text: string;
  /** Return multiple per $1 if the contract hits (undefined for sub-cent / dead prices). */
  multiple?: number;
}

/** Format a 0–1 probability as a real-money price (cents) + the implied return multiple. */
export function formatPrice(price: number): PriceDisplay {
  const pct = price * 100;
  if (pct >= 0.5) {
    const cents = Math.round(pct);
    return { text: `${cents}¢`, multiple: Math.round((100 / cents) * 10) / 10 };
  }
  return { text: pct > 0 ? "<1¢" : "—" };
}

/** The headline outcome chunk for a Sawa row, e.g. "Brazil 22%" or "Yes · no pool yet". */
function sawaOutcome(r: VenueResult): string {
  if (!r.top) return "no pool yet";
  const { label, oddsPct } = r.top;
  return oddsPct == null ? `${label} · no pool yet` : `${label} ${Math.round(oddsPct)}%`;
}

/** The headline outcome chunk for a real-money row, e.g. "Karen Bass 65¢ (1.5×)". */
function externalOutcome(r: VenueResult): string {
  if (!r.top || r.top.price == null) return "see venue";
  const { text, multiple } = formatPrice(r.top.price);
  return multiple ? `${r.top.label} ${text} (${multiple}×)` : `${r.top.label} ${text}`;
}

/** One compact line for a market. Source emoji + name, short title, price/odds, tappable link. */
function line(r: VenueResult): string {
  const emoji = r.realMoney ? "📈" : "🪙";
  const outcome = r.realMoney ? externalOutcome(r) : sawaOutcome(r);
  const head = `${emoji} **${r.sourceLabel}** · ${truncate(r.title)} · ${outcome}`;
  return r.url ? `${head} · [open](${r.url})` : head;
}

/** Short lead bubble — the answer up front, no preamble. */
export function searchLead(results: SearchResults): string {
  const q = results.query ? `"${results.query}"` : "that";
  return `🔎 Markets for ${q} — Sawa · Kalshi · Polymarket`;
}

/**
 * The Skyscanner body: Sawa first (our venue), then Kalshi, then Polymarket; each source's rows in
 * ranked order; a footer that defines both payout models + the disclaimer. Returns "" when empty
 * (callers use `emptyReply` instead).
 */
export function searchBody(results: SearchResults): string {
  const rows = [...results.sawa, ...results.kalshi, ...results.polymarket];
  if (rows.length === 0) return "";
  const body = rows.map(line).join("\n");
  const tail = results.truncated ? "\n\n_Showing top matches — narrow your search for more._" : "";
  return `${body}${tail}\n\n${FOOTER}`;
}

/**
 * The URL for a single richlink cover card — the top Sawa market with a link. `read.ts` only ever
 * returns public, open markets, so this never leaks a private/hidden market's OG image.
 */
export function topSawaRichlinkUrl(results: SearchResults): string | undefined {
  return results.sawa.find((r) => r.url)?.url;
}

/** Empty-state copy: no match anywhere → gentle nudge + tease create (not built yet). */
export function emptyReply(query: string): string {
  const q = query ? `"${query}"` : "that";
  return (
    `No live markets for ${q} on Sawa, Kalshi, or Polymarket yet.\n` +
    `Try a broader term — or want me to spin up a market on Sawa? (creating markets is coming soon)\n\n` +
    DISCLAIMER
  );
}

/** Convenience: the full rendered reply as plain parts the router turns into Spectrum content. */
export interface RenderedSearch {
  lead: string;
  body: string;
  /** Present → send a richlink cover card for the top Sawa market. */
  richlinkUrl?: string;
  empty: boolean;
}

export function renderSearch(results: SearchResults): RenderedSearch {
  if (results.empty) {
    return { lead: emptyReply(results.query), body: "", empty: true };
  }
  return {
    lead: searchLead(results),
    body: searchBody(results),
    richlinkUrl: topSawaRichlinkUrl(results),
    empty: false,
  };
}
