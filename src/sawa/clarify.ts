/**
 * Clarifying-question logic for the conversational SEARCH face — "ask, don't guess".
 *
 * When a search surfaces several genuinely DIFFERENT markets for one topic (e.g. "bitcoin" → a price
 * market, a $-target market, a dominance market; or one player's many props), the single best-guess
 * answer is a coin-flip. Instead the bot asks the user to pick — rendered as a native iMessage Poll on
 * platforms that support it, and a numbered text list everywhere else (local iMessage / terminal).
 *
 * This module is PURE + presentation-neutral (no Spectrum, no LLM): the deterministic decision (is the
 * result ambiguous?), option assembly, and answer resolution all live here so the five edge cases are
 * unit-testable. The renderer wraps the output in `poll(...)` or `text(...)`, and `intent.ts` may
 * refine the labels with the LLM — both downstream of this core.
 *
 * "Only when ambiguous" (owner decision): we ask ONLY when ≥2 strong, mutually-DISTINCT topics survive
 * clustering — so "World Cup winner" (one event exploded into per-team markets, all near-identical
 * titles) still answers directly with the favorite, while "bitcoin" (distinct questions) asks.
 */
import type { Venue, VenueResult } from "../venue";
import { tokenize } from "../venue";

/** One pickable choice — a short label and the specific market it resolves to. */
export interface ClarifyOption {
  label: string;
  result: VenueResult;
}

/** A clarifying question awaiting the user's pick. `question` doubles as the poll-vote correlation key. */
export interface ClarifyQuestion {
  question: string;
  options: ClarifyOption[];
}

/** Max choices shown — a poll/list stays scannable; the user can re-search if none fit. */
const MAX_OPTIONS = 4;
/** A candidate must clear this relevance to be worth offering (above the search floor of 0.34). */
const STRONG_RELEVANCE = 0.5;
/**
 * Pairwise title-token Jaccard at/above which two markets are treated as the SAME topic/event (so
 * per-outcome slices of one event — "…Brazil win?" / "…France win?" — collapse to one choice and we
 * don't ask). Tuned to separate one event's outcomes (~0.6) from one entity's distinct props (~0.3–0.4).
 */
const SAME_TOPIC_SIM = 0.5;
const LABEL_MAX = 44;

function truncate(s: string, max = LABEL_MAX): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Token-set Jaccard similarity of two market titles (0–1). Empty/empty = identical. */
function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Collapse a ranked candidate list to one representative per DISTINCT topic. Greedy in rank order:
 * each candidate joins the first existing cluster whose representative title is the "same topic"
 * (similarity ≥ `SAME_TOPIC_SIM`); otherwise it starts a new cluster. Because the input is already
 * ranked, the first (best) market of each topic is the representative. Dedupes the same market listed
 * across venues (near-identical titles) as a side effect.
 */
export function clusterTopics(candidates: VenueResult[]): VenueResult[] {
  const reps: VenueResult[] = [];
  for (const c of candidates) {
    if (!reps.some((r) => titleSimilarity(r.title, c.title) >= SAME_TOPIC_SIM)) reps.push(c);
  }
  return reps;
}

/** A concise option label for a market (the LLM may replace these later via `intent.refineClarify`). */
function optionLabel(r: VenueResult): string {
  return truncate(r.title);
}

/** The poll title / list header for a clarify question. */
export function clarifyQuestion(query: string): string {
  return query ? `Which "${query}" market did you mean?` : "Which market did you mean?";
}

/**
 * Decide whether to ask a clarifying question for this (already cross-venue ranked) candidate list.
 * Returns a `ClarifyQuestion` with up to `MAX_OPTIONS` choices when ≥2 strong, distinct topics exist;
 * otherwise `null` (answer directly with the single best market — the existing behavior). Pure +
 * deterministic; the caller may refine the labels / veto via the LLM.
 */
export function decideClarify(candidates: VenueResult[], query: string): ClarifyQuestion | null {
  if (candidates.length < 2) return null;
  const reps = clusterTopics(candidates).filter((r) => r.relevance >= STRONG_RELEVANCE);
  if (reps.length < 2) return null; // one (or zero) strong distinct topic → not ambiguous
  const options = reps.slice(0, MAX_OPTIONS).map((r) => ({ label: optionLabel(r), result: r }));
  return { question: clarifyQuestion(query), options };
}

const ORDINALS: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3,
};
const VENUE_WORDS: Record<string, Venue> = {
  sawa: "sawa", kalshi: "kalshi", polymarket: "polymarket", poly: "polymarket",
};

/** Strip benign trailing/leading filler so "the second one please" → "second". */
function coreAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(the|one|option|market|please|pls|plz|thanks?|thx|i|want|mean|meant|number|no\.?|#)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a user's answer to a pending clarify question — from a native poll tap (the exact option
 * label) OR a free-text reply ("2", "the second", "the kalshi one", "bitcoin price"). PRECISION over
 * recall: a non-matching or AMBIGUOUS answer returns `null` so the caller can treat the message as a
 * fresh intent (a new search / "another") rather than mis-resolving it to the wrong market.
 */
export function resolveAnswer(q: ClarifyQuestion, raw: string): ClarifyOption | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // 1. Exact label match — a poll tap returns the exact option label we sent.
  const exact = q.options.find((o) => o.label.trim().toLowerCase() === s);
  if (exact) return exact;

  const core = coreAnswer(s);

  // 2. Leading number (1-based).
  const num = s.match(/^#?\s*(\d{1,2})\b/);
  if (num) {
    const i = Number.parseInt(num[1]!, 10) - 1;
    return i >= 0 && i < q.options.length ? q.options[i]! : null;
  }

  // 3. Ordinal word ("first"/"second"/…/"last").
  if (core === "last") return q.options[q.options.length - 1] ?? null;
  if (core in ORDINALS) {
    const i = ORDINALS[core]!;
    return i < q.options.length ? q.options[i]! : null;
  }

  // 4. Venue word, when exactly one option is on that venue ("the kalshi one").
  for (const [word, venue] of Object.entries(VENUE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(s)) {
      const onVenue = q.options.filter((o) => o.result.venue === venue);
      if (onVenue.length === 1) return onVenue[0]!;
    }
  }

  // 5. Substring/token containment — the answer uniquely identifies one option's label or title.
  if (core.length >= 2) {
    const matches = q.options.filter((o) => {
      const hay = `${o.label} ${o.result.title}`.toLowerCase();
      return hay.includes(core);
    });
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

/** Numbered-list text fallback (local iMessage / terminal / any platform without native polls). */
export function renderClarifyText(q: ClarifyQuestion): string {
  const lines = q.options.map((o, i) => `${i + 1}. ${o.label}`);
  return `${q.question}\n${lines.join("\n")}\nReply with a number (or the name).`;
}
