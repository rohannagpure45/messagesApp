/**
 * Presentation layer for the conversational SEARCH face.
 *
 * Pure string builders (like format.ts): the router wraps the output in Spectrum's `markdown()` (cloud
 * iMessage) or plain `text()` (local/terminal). Each reply is ONE natural line — naming a single market,
 * its favorite (+ a runner-up for two-sided markets) and the venue — folk-style, instead of the old
 * wall of cross-venue rows. Links are NOT in the first reply; they come only when the user asks in a
 * follow-up (`renderLink`), as a bare tappable URL that cloud iMessage previews natively.
 *
 * Note: replies carry NO virtual-coin disclaimer (removed by owner decision for a clean folk-style
 * voice). The venue is named inline ("on Kalshi" / "on Sawa") and real-money venues read as real money
 * (cents + return multiple), so the line is still unambiguous. Consent + virtual-coin framing is
 * deferred to the future betting/money-action phase, not these discovery replies.
 */
import type { TopOutcome, Venue, VenueResult } from "../venue";

const TITLE_MAX = 52;

function truncate(s: string, max = TITLE_MAX): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Labels for the "No"/"Not" side of a binary market — a complement, never worth showing as a runner-up. */
const NEGATIVE_LABEL = /^(no|not)\b/i;

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

/** Format one outcome: real-money "<label> 65¢ (1.5×)" or Sawa "<label> 59%" / "<label> (no pool yet)". */
function chunk(o: TopOutcome, realMoney: boolean, withMultiple = true): string {
  if (realMoney) {
    if (o.price == null) return o.label;
    const { text, multiple } = formatPrice(o.price);
    return withMultiple && multiple ? `${o.label} ${text} (${multiple}×)` : `${o.label} ${text}`;
  }
  return o.oddsPct == null ? `${o.label} (no pool yet)` : `${o.label} ${Math.round(o.oddsPct)}%`;
}

/**
 * The favorite (+ runner-up) chunk for the conversational line. Shows the runner-up folk-style for a
 * genuine two-sided market ("Brazil 59%, Argentina 41%" / "Ronaldo 8¢, Messi 93¢") but suppresses it
 * for a Yes/No binary (a "No"/"Not" side is just the complement) and when the runner-up has no value.
 */
export function outcomeChunk(r: VenueResult): string {
  if (!r.top) return r.realMoney ? "see venue" : "no pool yet";
  const head = chunk(r.top, r.realMoney);
  const ru = r.runnerUp;
  const ruHasValue = ru && (r.realMoney ? ru.price != null && ru.price > 0 : ru.oddsPct != null);
  const oneSided = !ru || NEGATIVE_LABEL.test(ru.label) || NEGATIVE_LABEL.test(r.top.label);
  if (!ruHasValue || oneSided) return head;
  return `${head}, ${chunk(ru, r.realMoney, false)}`;
}

/**
 * A brief, factual flourish appended when SAWA_FOLK_TONE is on (off by default). Deliberately mild and
 * category-blind — it characterizes the price, it does not editorialize — so it stays brand-safe even
 * on sensitive markets. A richer (LLM-written) quip could replace this later; kept pure + testable.
 * Returns "" when no clear signal applies.
 */
export function folkQuip(r: VenueResult): string {
  const p = r.top?.price ?? (r.top?.oddsPct != null ? r.top.oddsPct / 100 : null);
  if (p == null) return "";
  if (p >= 0.9) return "heavy favorite";
  const ruP = r.runnerUp?.price ?? (r.runnerUp?.oddsPct != null ? r.runnerUp.oddsPct / 100 : null);
  if (ruP != null && Math.abs(p - ruP) <= 0.06) return "too close to call";
  if (p <= 0.35) return "wide open";
  return "";
}

export interface RenderOneOptions {
  /** Append a brief editorial flourish (folk tone). Off by default; gated by SAWA_FOLK_TONE upstream. */
  folkTone?: boolean;
}

/**
 * The conversational single-market reply: ONE natural line — market, favorite (+ runner-up for a
 * two-sided market), venue. NO link (links come only on a follow-up) and no disclaimer. Emits no
 * bold/markdown, so cloud and plain-text (local/terminal) render identically.
 */
export function renderOne(r: VenueResult, opts: RenderOneOptions = {}): string {
  const core = `${truncate(r.title)} — ${outcomeChunk(r)} on ${r.sourceLabel}`;
  const quip = opts.folkTone ? folkQuip(r) : "";
  return quip ? `${core} — ${quip}.` : `${core}.`;
}

/**
 * A compact, factual one-liner about a market — the grounding the intent LLM uses to ANSWER a question
 * about the currently-shown market ("what game is that for", "what are the odds"). NOT user-facing: it
 * lists only what we actually know (title, headline odds, venue, money type, resolve date, whether a
 * link exists) so the model can answer from facts and say "I don't have that" for anything absent
 * (notably the exact fixture — pmxt gives us the market title, not always the match it's tied to).
 */
/**
 * Neutralize a user-authored string (market title / outcome label) before it is embedded in the LLM
 * context — strip newlines, JSON/markdown structural chars, and braces so a crafted market title can't
 * break out of the facts line to inject instructions. Collapses whitespace and clamps length.
 */
function sanitizeForPrompt(s: string, max = 100): string {
  return s
    .replace(/[`{}\[\]<>\\]/g, " ")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function marketFacts(r: VenueResult): string {
  const parts = [`title ${sanitizeForPrompt(r.title)}`, `headline ${sanitizeForPrompt(outcomeChunk(r), 60)}`,
    `venue ${sanitizeForPrompt(r.sourceLabel, 20)}`];
  parts.push(r.realMoney ? "real-money market" : "virtual Sawa-coin market");
  if (r.closesAt != null) parts.push(`resolves ${new Date(r.closesAt).toISOString().slice(0, 10)}`);
  parts.push(r.url ? "a link is available on request" : "no link available");
  return parts.join("; ");
}

/**
 * Lead-in for a "send the link" follow-up. The URL itself is sent SEPARATELY as its own message (see
 * index.ts `sendLink` → `richlink(url)` on cloud, bare `text(url)` on local/terminal): a URL sent
 * ALONE is what iMessage unfurls into the market's Open Graph card (title + cover image), whereas a URL
 * buried in a sentence renders as a flat tappable link with no preview — the cloud-vs-local mismatch we
 * were seeing. So this line just names the venue; the card below it carries the link and image. Kept
 * emoji-free for the folk voice. Assumes `r.url` is present — the caller falls back to `renderNoVenue`.
 */
export function renderLink(r: VenueResult): string {
  return `Here's the ${r.sourceLabel} one:`;
}

/** Reply when "not that" has paged past the last candidate: out of options, nudge a fresh search. */
export function renderExhausted(query: string): string {
  const q = query ? `"${query}"` : "that";
  return `That's everything I've got for ${q} right now — try another search?`;
}

function venueLabel(venue: Venue): string {
  return venue === "sawa" ? "Sawa" : venue === "kalshi" ? "Kalshi" : "Polymarket";
}

/** Reply to a venue link request we can't fulfil — that venue had no match (or enrichment is off). */
export function renderNoVenue(venue: Venue, query: string): string {
  const q = query ? `"${query}"` : "that";
  return `I don't have a ${venueLabel(venue)} market for ${q} right now.`;
}

/**
 * Empty-state copy. When the external lookup ERRORED (a 429 rate-limit / timeout — not a real "no
 * match"), say so instead of claiming the market doesn't exist: the live test surfaced "bitcoin" being
 * reported as absent when pmxt had simply rate-limited us. Otherwise a gentle nudge + tease create.
 */
export function emptyReply(query: string, externalErrored = false): string {
  const q = query ? `"${query}"` : "that";
  if (externalErrored) {
    return (
      `Sawa has nothing on ${q}, and I couldn't reach Kalshi or Polymarket just now ` +
      `(usually a brief rate-limit). Try again in a few seconds.`
    );
  }
  return (
    `No live markets for ${q} on Sawa, Kalshi, or Polymarket yet.\n` +
    `Try a broader term — or want me to spin up a market on Sawa? (creating markets is coming soon)`
  );
}

/**
 * Flatten any residual markdown to plain text for platforms that strip formatting — iMessage **local
 * mode** (reads/sends via the Mac's Messages app) and the terminal. The conversational renderers emit
 * no bold/links (only bare URLs), so this is a near no-op today, but is applied for safety/consistency.
 */
export function toPlainText(md: string): string {
  return md
    // [open](url) → bare url. The URL body allows one level of balanced parens so a link target like
    // …/Example_(word) survives intact instead of truncating at the first ")".
    .replace(/\[([^\]]+)\]\(([^()]*(?:\([^)]*\)[^()]*)*)\)/g, "$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** → bold
    .replace(/_([^_]+)_/g, "$1"); // _italic_ → italic
}
