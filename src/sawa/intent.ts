/**
 * Intent parsing for the conversational SEARCH face.
 *
 * Two-stage, cost-controlled:
 *  1. REGEX-FIRST GATE (`classify`) — deterministic, zero-cost. Strips the address token, then
 *     classifies the message and extracts a clean search subject. Most real messages resolve here.
 *  2. LLM FALLBACK (Gemini Flash-Lite via the OpenAI-compatible API) — only when the gate is
 *     unsure AND a key is configured. JSON mode, low temperature, output re-validated and clamped.
 *     Any error (timeout, bad JSON, network) falls back to the gate's best guess — the LLM never
 *     blocks a reply.
 *
 * v1 scope is intentionally small: `search` vs `other`. Create/odds/bet land in later phases, so
 * the schema is forward-compatible (an unknown kind clamps to `other`).
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { IntentConfig } from "./config";
import type { Venue } from "../venue";
import type { ClarifyQuestion, ClarifyOption } from "./clarify";

/**
 * `search` (new topic) and `other` (greeting/create/account/help) are the cold-start kinds. `next`
 * and `link` are FOLLOW-UPS — only reachable when there's an active market in the conversation:
 *   - `next`  — "not that" / "another" / "more": page to the next-best candidate.
 *   - `link`  — "send the kalshi link" / bare "kalshi": surface a market's link (venue-scoped or current).
 */
export type IntentKind = "search" | "next" | "link" | "answer" | "other";

export interface Intent {
  kind: IntentKind;
  /** The cleaned search subject (e.g. "FIFA World Cup"). Present when kind === "search". */
  query?: string;
  /** Which venue a `link` follow-up targets (undefined = the currently-shown market / generic). */
  venue?: Venue;
  /**
   * A short, grounded reply the LLM wrote for `answer` — the user asked a QUESTION about the
   * currently-shown market ("what game is that for", "what are the odds", "is that real money") and
   * the model answered from the market facts instead of triggering a fresh search.
   */
  reply?: string;
  /** Which stage decided this — useful for analytics/debugging. */
  via: "regex" | "llm" | "fallback";
}

/**
 * A typed digest of the active conversation, passed to `parseIntent` so follow-ups disambiguate from
 * new searches. NOT a raw transcript — Spectrum is a forward stream, so the durable per-thread summary
 * IS the history. Built by `conversation.toContext(state)`.
 */
export interface FollowupContext {
  /** True when there is a live market the user could be reacting to ("not that" / "send the link"). */
  hasActiveMarket: boolean;
  /** The active search subject — for the LLM context line. */
  query?: string;
  /** The venue of the currently-shown market. */
  currentVenue?: Venue;
  /** Which venues returned a market this search — so a "kalshi link" with no Kalshi match degrades gracefully. */
  venuesPresent: Venue[];
  /**
   * A one-line factual digest of the currently-shown market (title, headline odds, venue, money type,
   * resolve date, link availability) — the grounding the LLM uses to ANSWER a question about it
   * ("what game is that for") instead of mis-searching the question. Built by `conversation.toContext`.
   */
  currentMarketFacts?: string;
}

const MAX_QUERY_LEN = 120;

/** Leading address tokens to strip: "sawa", "@sawa", "hey sawa,", "sawa:" … */
export function stripAddress(text: string, botName: string): string {
  const name = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Optional greeting + optional @ + bot name + optional punctuation, at the very start.
  const re = new RegExp(`^\\s*(?:hey|hi|hello|yo|ok|okay)?[\\s,]*@?${name}[\\s,:;-]*`, "i");
  return text.replace(re, "").trim();
}

// A bare acknowledgement / greeting — never a search.
const GREETING_RE =
  /^(hi|hey+|hello|yo|sup|wassup|gm|good (morning|night|evening)|thanks?|thank you|ty|tysm|ok|okay|k|kk|cool|nice|great|lol|lmao|haha|👍|🙏|❤️|np)\b[\s!.?]*$/i;

// Capabilities not in the SEARCH face (deferred) — classify as "other" so we don't mis-search them.
const CREATE_RE = /\b(make|create|start|open|set up|new)\s+(a\s+|an\s+|the\s+)?(market|prediction|bet|poll|wager)\b/i;
const ACCOUNT_RE = /\b(my )?(balance|wallet|coins|portfolio|positions?|my bets?|leaderboard|rank|profile|watchlist)\b/i;
const HELP_RE = /^\/?\s*(help|commands?|what can you do|how does this work)\b/i;

// Explicit search triggers + the phrase to peel off to get the subject. The first entry's
// alternation is ordered LONGEST-FIRST ("look up for" before "look up", "find me" before "find",
// "search for" before "search") so the most specific phrasing wins and the whole trigger is
// stripped — "look for X" / "search for X" / "find me X" must resolve here, not leak to the LLM.
const SEARCH_VERBS = "search for|find me|look up for|look for|look up|lookup|find|search|show me|show|get me";
const SEARCH_TRIGGERS: { re: RegExp; strip: RegExp }[] = [
  { re: new RegExp(`^(${SEARCH_VERBS})\\b`, "i"), strip: new RegExp(`^(${SEARCH_VERBS})\\b\\s*`, "i") },
  { re: /\bwhere can i (bet|trade|wager)( on)?\b/i, strip: /^.*\bwhere can i (bet|trade|wager)( on)?\b\s*/i },
  { re: /\b(bet|trade|wager) on\b/i, strip: /^.*\b(bet|trade|wager) on\b\s*/i },
  { re: /\bodds (on|for|of)\b/i, strip: /^.*\bodds (on|for|of)\b\s*/i },
  { re: /\b(markets?|predictions?) (on|for|about)\b/i, strip: /^.*\b(markets?|predictions?) (on|for|about)\b\s*/i },
  { re: /\b(is there|are there|any) (a )?markets?\b/i, strip: /^.*\b(is there|are there|any) (a )?markets?\b( on| for| about)?\s*/i },
];

/**
 * A leading "(a/the) market(s)/prediction/bet/odds/line (on|for|about|of)" role phrase. When the
 * FIRST search trigger is a bare verb ("find me"), it strips only itself — so "find me a market on
 * bitcoin" leaves "a market on bitcoin", and the role-word "market" then spuriously matches an
 * unrelated Sawa market ("…damage at the market"). Peeling this residual yields the clean entity
 * ("bitcoin"). Anchored at the start; only fires when a real subject follows, so "market cap of X"
 * (no on/for/about/of after "market") and "stock market crash" are untouched.
 */
const LEADING_ROLE_PHRASE_RE =
  /^\s*(?:markets?|predictions?|bets?|wagers?|polls?|lines?|odds)\s+(?:on|for|about|of)\s+(?:(?:the|a|an)\s+)?/i;

/**
 * A trailing venue word ("… kalshi" / "… on polymarket" / "… poly") that leaked into the search SUBJECT
 * — e.g. the follow-up LLM echoing the current venue ("spaceX stock price kalshi"). A venue name is never
 * a legitimate search subject, so peel it off the END before searching. Only matches a trailing token, so
 * "Poland" / "polygon" (not whole-word "poly") and a mid-phrase mention are untouched.
 */
const TRAILING_VENUE_RE = /(?:\s+(?:on\s+)?(?:kalshi|polymarket|poly|sawa))+\s*$/i;

/** Trim trailing filler/punctuation and a leading article/role-phrase from an extracted subject. */
function cleanQuery(s: string): string {
  return s
    .replace(/[?!.]+$/g, "")
    .replace(/\bmarkets?\??$/i, "")
    .replace(/\b(please|pls|plz|thanks?|thx)\b/gi, "")
    .replace(/^\s*(the|a|an)\s+/i, "") // leading article: "the FIFA World Cup" → "FIFA World Cup"
    .replace(LEADING_ROLE_PHRASE_RE, "") // residual role phrase: "market on bitcoin" → "bitcoin"
    .replace(TRAILING_VENUE_RE, "") // residual venue word: "spaceX stock price kalshi" → "spaceX stock price"
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

/** Regex-first classification. `confident` gates whether the LLM gets consulted. */
export function classify(rawText: string, botName: string): Intent & { confident: boolean } {
  const text = stripAddress(rawText, botName);

  if (text.length === 0 || GREETING_RE.test(text)) {
    return { kind: "other", via: "regex", confident: true };
  }
  if (CREATE_RE.test(text) || ACCOUNT_RE.test(text) || HELP_RE.test(text)) {
    return { kind: "other", via: "regex", confident: true };
  }

  for (const { re, strip } of SEARCH_TRIGGERS) {
    if (re.test(text)) {
      const query = cleanQuery(text.replace(strip, ""));
      // A trigger with no subject left ("find") is not actionable — let the LLM/fallback decide.
      if (query.length >= 2) return { kind: "search", query, via: "regex", confident: true };
      return { kind: "search", query: cleanQuery(text), via: "regex", confident: false };
    }
  }

  // No explicit trigger. Since the message was addressed to the bot (router mention-gates) and is
  // not a greeting/create/account/help, it is most likely a bare-topic search ("sawa world cup").
  // Treat it as a search candidate, but NOT confident — the LLM refines if available.
  return { kind: "search", query: cleanQuery(text), via: "fallback", confident: false };
}

/** A bare venue word, optionally with a trailing "?": "kalshi", "polymarket?", "poly". */
const BARE_VENUE_RE = /^(sawa|kalshi|polymarket|poly)\s*\??$/i;
/** A venue word anywhere in the message. */
const VENUE_WORD_RE = /\b(sawa|kalshi|polymarket|poly)\b/i;
/** Explicit "give me the link/url" wording. */
const LINK_WORD_RE = /\b(link|url)\b/i;
/** A "fetch it for me" verb that, paired with a venue, reads as a link request. */
const SEND_VERB_RE = /\b(send|share|gimme|give|got|have|get|grab|drop|pull up|show|open)\b/i;
/**
 * "Show me a different one" — only meaningful when there is an active market. Anchored to end-of-string
 * (with an optional tail of benign fillers like "one"/"please"/"market") so a phrase that STARTS with a
 * rejection token but continues into a real request — "more info please", "no idea what that is",
 * "next election" — is NOT swallowed as a follow-up; it falls through to the gate / context LLM. Bare or
 * filler-tailed rejections ("not that", "another one", "next market", "more please") still match. We
 * favor precision here: a missed "next" just means the user rephrases, but a false "next" silently
 * pages away the market they were looking at.
 */
const NEXT_RE =
  /^(?:not (?:that|it|this|right)|that'?s not it|nah+|nope+|no+|different(?: one)?|another(?:\s+one)?|some ?thing ?else|next|more|others?|what else|wrong(?: one)?|try again|show (?:me )?(?:more|another|others?|the others?))(?:\s+(?:one|market|markets|please|pls|plz|thanks?|thx|now|then|instead))*[\s!?.,]*$/i;

function extractVenue(text: string): Venue | undefined {
  const m = text.match(VENUE_WORD_RE);
  if (!m) return undefined;
  const w = m[1]!.toLowerCase();
  return w === "poly" ? "polymarket" : (w as Venue);
}

/**
 * Regex follow-up classifier — consulted BEFORE the cold-start gate and ONLY when there is an active
 * market (`ctx.hasActiveMarket`). Returns a CONFIDENT intent for the unambiguous follow-ups:
 *   - `link` — an explicit "link"/"url" word, a send-verb paired with a venue, or a bare venue word.
 *   - `next` — "not that" / "nah" / "another" / "more" / "show me another".
 * Returns `null` for everything else (incl. always when there's no active market), so an ambiguous
 * follow-up ("what about kalshi") or a genuine new topic falls through to the cold gate / context LLM,
 * and a cold "next"/"link" can never be mis-read as a follow-up.
 */
export function classifyFollowup(
  rawText: string,
  botName: string,
  ctx: FollowupContext,
): (Intent & { confident: boolean }) | null {
  if (!ctx.hasActiveMarket) return null;
  const text = stripAddress(rawText, botName).trim();
  if (!text) return null;

  const venue = extractVenue(text);
  const wantsLink =
    LINK_WORD_RE.test(text) || BARE_VENUE_RE.test(text) || (venue !== undefined && SEND_VERB_RE.test(text));
  if (wantsLink) return { kind: "link", venue, via: "regex", confident: true };

  if (NEXT_RE.test(text)) return { kind: "next", via: "regex", confident: true };
  return null;
}

const SYSTEM_PROMPT =
  "You classify a single chat message sent to a prediction-market assistant. " +
  'Return ONLY JSON: {"kind":"search"|"other","query":string}. ' +
  '"search" = the user wants to find/see prediction markets or odds on a topic. ' +
  '"other" = greeting, small talk, account/balance, help, or a request to CREATE a market. ' +
  'For "search", set "query" to the SEARCHABLE ENTITY (and a one-word prop if present) — the ' +
  "team, player, event, or asset the market is about. Strip filler and role words: " +
  '"sawa", "find", "look for", "where can I bet on", "odds on", "markets for", "player props on", ' +
  '"lines for", surrounding team-context words, and trailing punctuation. ' +
  "DROP a trailing TIMEFRAME qualifier (e.g. \"15 minutes\", \"this week\", \"today\", \"end of year\") and " +
  "keep just the core asset/entity — the search surfaces the whole family of that market and the user " +
  "picks the specific one next. " +
  'Examples: "look for player props on Mexico Raul Jimenez" -> {"kind":"search","query":"Raul Jimenez goals"}; ' +
  '"odds on the FIFA World Cup" -> {"kind":"search","query":"FIFA World Cup"}; ' +
  '"bitcoin 15 minutes" -> {"kind":"search","query":"bitcoin"}; ' +
  '"hey what is up" -> {"kind":"other","query":""}. ' +
  'For "other", set "query" to "". Return a SINGLE JSON object, never an array.';

/**
 * Extended prompt used ONLY for the ambiguous-with-active-market case: the assistant just showed a
 * market, so the same message could be a follow-up (next/link) or a brand-new search.
 */
const FOLLOWUP_SYSTEM_PROMPT =
  "You handle ONE chat message to a prediction-market assistant that just showed the user a market. " +
  'Return ONLY JSON: {"kind":"search"|"next"|"link"|"answer"|"other","query":string,"venue":"sawa"|"kalshi"|"polymarket"|"","reply":string}. ' +
  '"next" = the user rejects the shown market or wants a different/next one ("not that","another","more"). ' +
  '"link" = the user wants the link/URL for a market; if they name a venue put it in "venue", else "". ' +
  '"answer" = the user asks a QUESTION about the CURRENTLY-SHOWN market (what game/match/event it is, ' +
  'what the odds/price/return are, when it resolves, whether it is real money) — write a SHORT (1 sentence) ' +
  'reply in "reply" using ONLY the facts in the context line; if a fact is not given, say you don\'t have it ' +
  '(do NOT invent fixtures, odds, or links). ' +
  '"search" = the user asks about a genuinely NEW topic; put the clean topic (no filler) in "query". ' +
  '"other" = greeting, small talk, account/help, or a request to CREATE a market. ' +
  'Set every unused field to "". Return a SINGLE JSON object, never an array. ' +
  // Hardening (the Solana/Haaland off-schema bug): when an UNRELATED new topic arrives while a market
  // for a different subject is in context, flash-lite would emit {"error":"No market found..."} — it has
  // no market data and was answering a question we never asked. Forbid that escape hatch outright.
  'You have NO market data and CANNOT know whether any market exists — NEVER claim a market does or ' +
  'does not exist, NEVER refuse, and NEVER output an "error" field or any key other than ' +
  'kind/query/venue/reply. If the message is UNRELATED to the shown market (a topic mismatch) or you are ' +
  'unsure it is a next/link/answer/other follow-up, classify it as {"kind":"search"} with the clean new ' +
  'topic in "query".';

/** A one-line context summary fed to the LLM alongside the follow-up prompt (not a raw transcript). */
function contextDigest(ctx: FollowupContext): string {
  const venues = ctx.venuesPresent.length ? ctx.venuesPresent.join(", ") : "none";
  const facts = ctx.currentMarketFacts ? ` Current market: ${ctx.currentMarketFacts}.` : "";
  return `Context: currently showing a ${ctx.currentVenue ?? "?"} market for "${ctx.query ?? ""}". Venues with a match: ${venues}.${facts}`;
}

interface RawLlm {
  kind?: unknown;
  query?: unknown;
  venue?: unknown;
  reply?: unknown;
}

/**
 * Parse an LLM completion body into the intent object. Tolerates: ```code fences```, leading/trailing
 * prose, AND — critically — an ARRAY wrapper. gemini-flash-lite intermittently returns `[ {…} ]` (or
 * several objects on multiple lines) despite json_object mode, which broke a plain first-`{`…last-`}`
 * slice ("Unexpected non-whitespace character after JSON"). We narrow to the first JSON value (object
 * or array) and, for an array, take its first object. Throws on unrecoverable input — the caller
 * catches it and falls back to the regex gate.
 */
function parseLlmJson(content: string): RawLlm {
  let s = content.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  const objAt = s.indexOf("{");
  const arrAt = s.indexOf("[");
  let slice: string;
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) {
    slice = s.slice(arrAt, s.lastIndexOf("]") + 1); // array-wrapped: [ {…}, … ]
  } else if (objAt !== -1) {
    slice = s.slice(objAt, s.lastIndexOf("}") + 1); // object, possibly prose-padded
  } else {
    slice = s;
  }
  const parsed = JSON.parse(slice) as unknown;
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== "object") throw new Error("LLM JSON was not an object");
  return obj as RawLlm;
}

/** Clamp an arbitrary LLM venue string to a known Venue, or undefined. */
function clampVenue(v: unknown): Venue | undefined {
  if (typeof v !== "string") return undefined;
  const w = v.toLowerCase();
  if (w === "poly") return "polymarket";
  return w === "sawa" || w === "kalshi" || w === "polymarket" ? (w as Venue) : undefined;
}

/** Interpret a cold-start LLM result (search/other only) — identical behavior to before. */
function interpretColdLlm(parsed: RawLlm): Intent | null {
  const kind: IntentKind = parsed.kind === "search" ? "search" : "other";
  if (kind === "other") return { kind, via: "llm" };
  const query = typeof parsed.query === "string" ? cleanQuery(parsed.query) : "";
  if (query.length < 2) return null; // unusable — let the caller keep the regex guess
  return { kind: "search", query, via: "llm" };
}

/** Interpret a follow-up LLM result (search/next/link/answer/other + venue/reply), strictly clamped. */
function interpretFollowupLlm(parsed: RawLlm): Intent | null {
  switch (parsed.kind) {
    case "next":
      return { kind: "next", via: "llm" };
    case "link":
      return { kind: "link", venue: clampVenue(parsed.venue), via: "llm" };
    case "answer": {
      // A grounded reply about the current market. Require a usable reply, else fall back to the gate.
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      return reply.length >= 2 ? { kind: "answer", reply: reply.slice(0, 320), via: "llm" } : null;
    }
    case "search": {
      const query = typeof parsed.query === "string" ? cleanQuery(parsed.query) : "";
      return query.length >= 2 ? { kind: "search", query, via: "llm" } : null;
    }
    case "other":
      return { kind: "other", via: "llm" };
    default:
      return null; // unknown kind → let the caller keep the regex gate's guess
  }
}

let client: OpenAI | null = null;
function getClient(cfg: IntentConfig): OpenAI {
  if (!client) client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 1 });
  return client;
}
/** Test seam: inject a stub client (or reset with null). */
export function __setClient(c: OpenAI | null): void {
  client = c;
}

// --- intent + clarify caches (durable, time-invariant) ------------------------------------------
// The COLD-START intent classification (SYSTEM_PROMPT path) and the clarify REFINEMENT decision are
// each a pure function of their text inputs: "Wu versus Djokovic" → {search,"Wu Djokovic"}, and
// ("Lionel messi", [those candidate titles]) → keep #1/#3, drop #2 — regardless of WHEN asked. Unlike
// the market-id / feed caches (whose prices go stale), these mappings are TIME-INVARIANT, so the TTL
// is long and there is no revalidation. Two deliberate exclusions keep them correct:
//   • The active-market FOLLOW-UP path is NOT cached — its answer depends on the currently-shown
//     market (a context digest), so it is not a function of the message text alone.
//   • The clarify cache stores only the LLM's STRUCTURAL decision (which candidates to keep + labels,
//     or veto) — never the market `result` objects, which carry live PRICES. On a hit the decision is
//     re-bound onto the CURRENT question, so prices stay fresh; only the Gemini round-trip is skipped.
// Bounded by an LRU cap (message/clarify text is unbounded, unlike the finite market set). Off by
// default (unit tests stay in-memory); index.ts opts into disk persistence. The 24h TTL also bounds a
// rare nondeterministic mis-parse and any prompt-change staleness that survives on disk across a deploy.
const INTENT_TTL_MS = 24 * 60 * 60_000; // 24h
const INTENT_CACHE_MAX = 500; // LRU cap, per cache

interface IntentCacheEntry {
  at: number;
  intent: Intent;
}
const intentCache = new Map<string, IntentCacheEntry>();

/** The LLM's structural clarify decision: a veto, or the kept candidate indices + (optional) relabels. */
type ClarifyDecision = { veto: true } | { veto: false; picks: { idx: number; label?: string }[] };
interface ClarifyCacheEntry {
  at: number;
  decision: ClarifyDecision;
}
const clarifyCache = new Map<string, ClarifyCacheEntry>();

/** Injectable clock for deterministic tests (mirrors src/pmxt/discover.ts; shared by both caches). */
let intentNow: () => number = () => Date.now();
export function __setIntentClock(fn: () => number): void {
  intentNow = fn;
}

/** Normalize a message into a stable key: lowercase, collapse whitespace, drop trailing punctuation. */
function intentCacheKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/g, "");
}

/** Key the clarify cache by the only inputs the model sees: the topic + the candidate titles. */
function clarifyCacheKey(query: string, question: ClarifyQuestion): string {
  const titles = question.options.map((o) => o.result.title.trim().toLowerCase()).join("|");
  return `${query.trim().toLowerCase()}::${titles}`;
}

/**
 * Re-bind a cached clarify decision onto the CURRENT question (so option prices are fresh, never
 * cached). Returns the RELEVANT subset to ask (≥2 options), the single market to answer with (1), or
 * null to fall back to the top candidate — byte-identical to the original inline mapping.
 */
function applyClarifyDecision(decision: ClarifyDecision, question: ClarifyQuestion): ClarifyQuestion | null {
  if (decision.veto) return null;
  const kept: ClarifyOption[] = [];
  for (const { idx, label } of decision.picks) {
    const orig = idx >= 0 && idx < question.options.length ? question.options[idx] : undefined;
    if (!orig || kept.some((k) => k.result === orig.result)) continue;
    kept.push({ label: label ?? orig.label, result: orig.result });
    if (kept.length >= 4) break;
  }
  return kept.length >= 1 ? { ...question, options: kept } : null;
}

/** Move an entry to the end of its Map (most-recently-used) WITHOUT resetting its TTL anchor. */
function touchLru<V>(map: Map<string, V>, key: string, entry: V): void {
  map.delete(key);
  map.set(key, entry);
}

/** Insert with write-through persistence + LRU eviction of the oldest entry once past the cap. */
function setWithCap<V>(map: Map<string, V>, key: string, entry: V): void {
  map.set(key, entry);
  if (map.size > INTENT_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  saveIntentModuleCache();
}

// --- durable persistence (one file backs BOTH intent-module caches) -----------------------------
interface IntentModuleSnapshot {
  intent?: { [key: string]: IntentCacheEntry };
  clarify?: { [key: string]: ClarifyCacheEntry };
}
export interface IntentCachePersistence {
  load(): IntentModuleSnapshot | null;
  save(data: IntentModuleSnapshot): void;
}
let intentPersist: IntentCachePersistence | undefined;

function saveIntentModuleCache(): void {
  if (!intentPersist) return;
  const intent: { [key: string]: IntentCacheEntry } = {};
  for (const [k, v] of intentCache) intent[k] = v;
  const clarify: { [key: string]: ClarifyCacheEntry } = {};
  for (const [k, v] of clarifyCache) clarify[k] = v;
  intentPersist.save({ intent, clarify });
}

/** Enable durable persistence: rehydrate both caches now (dropping too-stale entries), then write through. */
export function enableIntentCachePersistence(adapter: IntentCachePersistence): void {
  intentPersist = adapter;
  const snap = adapter.load();
  if (!snap) return;
  const t = intentNow();
  for (const [k, v] of Object.entries(snap.intent ?? {})) {
    if (v && typeof v.at === "number" && v.intent && t - v.at < INTENT_TTL_MS) intentCache.set(k, v);
  }
  for (const [k, v] of Object.entries(snap.clarify ?? {})) {
    if (v && typeof v.at === "number" && v.decision && t - v.at < INTENT_TTL_MS) clarifyCache.set(k, v);
  }
}

/** File-backed persistence (atomic temp+rename, fail-soft) — mirrors fileCachePersistence in discover.ts. */
export function fileIntentCachePersistence(filePath: string): IntentCachePersistence {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as IntentModuleSnapshot;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn(`[intent] could not read cache ${filePath} (${(err as Error).message}) — starting cold.`);
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
        console.warn(`[intent] could not persist cache ${filePath} (${(err as Error).message}) — kept in memory only.`);
      }
    },
  };
}

/** Test seam: set/clear the persistence adapter without hydrating (mirrors __setCachePersistence). */
export function __setIntentCachePersistence(p: IntentCachePersistence | null): void {
  intentPersist = p ?? undefined;
}
/** Test/bench helper: clear the cold-start intent cache between cases. */
export function __clearIntentCache(): void {
  intentCache.clear();
}
/** Test/bench helper: clear the clarify-decision cache between cases. */
export function __clearClarifyCache(): void {
  clarifyCache.clear();
}

async function classifyWithLlm(text: string, cfg: IntentConfig, ctx?: FollowupContext): Promise<Intent | null> {
  const useCtx = ctx?.hasActiveMarket === true;
  // Cold-start classification is a pure function of the text → cacheable. The active-market path
  // depends on the shown market (context digest), so it is NEVER cached (the text-only key is wrong).
  const key = useCtx ? null : intentCacheKey(text);
  if (key !== null) {
    const hit = intentCache.get(key);
    if (hit && intentNow() - hit.at < INTENT_TTL_MS) {
      touchLru(intentCache, key, hit);
      return hit.intent; // a cached cold-start result keeps via:"llm" (it WAS an LLM result)
    }
  }
  try {
    const messages = useCtx
      ? [
          { role: "system" as const, content: FOLLOWUP_SYSTEM_PROMPT },
          { role: "system" as const, content: contextDigest(ctx!) },
          { role: "user" as const, content: text.slice(0, 400) },
        ]
      : [
          { role: "system" as const, content: SYSTEM_PROMPT },
          { role: "user" as const, content: text.slice(0, 400) },
        ];
    const resp = await getClient(cfg).chat.completions.create(
      // 256 (was 80): the JSON schema is tiny, but the model occasionally pretty-prints multi-line
      // JSON that overran an 80-token cap → truncated mid-string → `Unterminated string` → silent
      // regex fallback. 256 removes truncation for any reasonable body.
      { model: cfg.model, temperature: 0, max_tokens: 256, response_format: { type: "json_object" }, messages },
      { timeout: 6_000 },
    );
    const content = resp.choices[0]?.message?.content;
    if (!content) return null;
    let parsed: RawLlm;
    try {
      parsed = parseLlmJson(content);
    } catch (parseErr) {
      // Keep the raw body (truncated) so a future regression is diagnosable, then fall back.
      console.warn(
        `[intent] LLM returned unparseable JSON — using regex gate. ${(parseErr as Error).message}; body=${content.slice(0, 200)}`,
      );
      return null;
    }
    const result = useCtx ? interpretFollowupLlm(parsed) : interpretColdLlm(parsed);
    // Cache only a SUCCESSFUL cold-start classification — never null (a transient bad parse / unusable
    // query is not a stable property of the text), and never the context path.
    if (key !== null && result) setWithCap(intentCache, key, { at: intentNow(), intent: result });
    return result;
  } catch (err) {
    console.warn(`[intent] LLM classify failed — using regex gate. ${(err as Error).message}`);
    return null;
  }
}

/**
 * Optional LLM refinement for a clarifying question. The deterministic `clarify.decideClarify` already
 * decided these candidates are ambiguous; this lets the model (a) VETO that — `ambiguous:false` when
 * the titles are really one market's outcomes (e.g. different teams to win the SAME event), so the
 * caller answers directly — and (b) replace the raw titles with short, natural option labels. Strictly
 * fail-soft: any error / unusable shape returns the deterministic question UNCHANGED (we still ask).
 */
const CLARIFY_SYSTEM_PROMPT =
  "You help a prediction-market assistant ask a GOOD clarifying question. You are given a topic and a " +
  "numbered list of candidate market titles the search found. Keep only the candidates that are " +
  "genuinely DIFFERENT, RELEVANT markets the user might mean. " +
  'Return ONLY JSON: {"ambiguous":boolean,"options":[{"n":number,"label":string}]}. ' +
  "RULES: DROP any candidate that is OFF-TOPIC or not really about the topic (noise — e.g. a market " +
  "about a different subject that merely shares a name word). DROP duplicates that are the same market " +
  'or outcomes of ONE event (keep the favorite). "n" is the candidate NUMBER from the list; "label" ' +
  "is a SHORT (under 6 words) human label. Keep at most 4, in priority order. " +
  "Set ambiguous=false (options may be empty) when the candidates are really one market's outcomes, OR " +
  "only ONE is relevant — the assistant then just shows the best market. " +
  "Return a SINGLE JSON object, never an array.";

interface RawClarifyOption {
  n?: unknown;
  label?: unknown;
}
interface RawClarifyLlm {
  ambiguous?: unknown;
  options?: unknown;
}

/**
 * Optional LLM refinement for a clarifying question. The deterministic `clarify.decideClarify` decided
 * these candidates are ambiguous; this lets the model (a) VETO that (`ambiguous:false` → answer
 * directly), (b) DROP off-topic noise (e.g. "Trump praise Messi" from a "Lionel Messi" search), and
 * (c) relabel. Returns a question with the RELEVANT subset (≥2 options) to ask, or `null` to answer
 * directly (veto, or fewer than 2 relevant survive). Strictly fail-soft → the deterministic question.
 */
export async function refineClarify(
  query: string,
  question: ClarifyQuestion,
  cfg: IntentConfig,
): Promise<ClarifyQuestion | null> {
  // Cache the LLM's structural decision keyed by (topic + candidate titles) — the only inputs the
  // model sees, and a time-invariant keep/drop/relabel/veto choice. On a hit, re-bind onto the CURRENT
  // question so option prices stay fresh; only the Gemini round-trip is skipped. (See the cache block.)
  const key = clarifyCacheKey(query, question);
  const cached = clarifyCache.get(key);
  if (cached && intentNow() - cached.at < INTENT_TTL_MS) {
    touchLru(clarifyCache, key, cached);
    return applyClarifyDecision(cached.decision, question);
  }

  const list = question.options.map((o, i) => `${i + 1}. ${o.result.title}`).join("\n");
  try {
    const resp = await getClient(cfg).chat.completions.create(
      {
        model: cfg.model,
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
        messages: [
          { role: "system" as const, content: CLARIFY_SYSTEM_PROMPT },
          { role: "user" as const, content: `Topic: ${query || "(none)"}\nMarkets:\n${list}` },
        ],
      },
      { timeout: 6_000 },
    );
    const content = resp.choices[0]?.message?.content;
    if (!content) return question;
    let parsed: RawClarifyLlm;
    try {
      parsed = parseLlmJson(content) as unknown as RawClarifyLlm;
    } catch {
      return question; // unparseable → keep the deterministic question
    }
    // VETO: the model says these are one market's outcomes → don't ask, answer directly. Cacheable.
    if (parsed.ambiguous === false || parsed.ambiguous === "false" || parsed.ambiguous === 0) {
      const decision: ClarifyDecision = { veto: true };
      setWithCap(clarifyCache, key, { at: intentNow(), decision });
      return applyClarifyDecision(decision, question);
    }
    if (!Array.isArray(parsed.options)) return question; // unexpected shape → deterministic (transient, not cached)
    // Validate the LLM's {n,label} picks into stable 0-based indices + (optional) relabels, dropping
    // out-of-range numbers and dupes. Indices (not market objects) are cached, so prices re-bind fresh.
    const picks: { idx: number; label?: string }[] = [];
    const seen = new Set<number>();
    for (const raw of parsed.options as RawClarifyOption[]) {
      const n = typeof raw?.n === "number" ? raw.n : Number(raw?.n);
      const idx = Number.isFinite(n) ? n - 1 : -1;
      if (idx < 0 || idx >= question.options.length || seen.has(idx)) continue;
      seen.add(idx);
      const label = typeof raw?.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 44) : undefined;
      picks.push({ idx, label });
      if (picks.length >= 4) break;
    }
    // Cache the decision, then return the RELEVANT subset (1 = answer with that market; ≥2 = ask; the
    // caller distinguishes by length). `null` ONLY when the model dropped everything → top candidate.
    const decision: ClarifyDecision = { veto: false, picks };
    setWithCap(clarifyCache, key, { at: intentNow(), decision });
    return applyClarifyDecision(decision, question);
  } catch (err) {
    console.warn(`[clarify] LLM refine failed — using deterministic question. ${(err as Error).message}`);
    return question;
  }
}

/**
 * Parse a message into an Intent. With an active-market `ctx`, a zero-cost regex follow-up gate runs
 * FIRST (so "not that"/"send the kalshi link" resolve without the LLM). Otherwise the cold-start gate
 * runs as before; the LLM is consulted only when the gate is unsure and `intentCfg` is provided —
 * context-aware when there's an active market, byte-identical to before when there isn't. Never throws.
 */
export async function parseIntent(
  rawText: string,
  botName: string,
  intentCfg: IntentConfig | null,
  ctx?: FollowupContext,
): Promise<Intent> {
  // 1. Active-market follow-up gate (regex, zero-cost) — only fires when a market is in play.
  if (ctx?.hasActiveMarket) {
    const fu = classifyFollowup(rawText, botName, ctx);
    if (fu?.confident) {
      const { confident: _c, ...intent } = fu;
      return intent;
    }
  }
  // 2. Cold-start gate (unchanged for callers without ctx). A confident new search/greeting wins.
  const gate = classify(rawText, botName);
  if (gate.confident || !intentCfg) {
    const { confident: _c, ...intent } = gate;
    return intent;
  }
  // 3. LLM fallback — context-aware when there's an active market, else identical to before.
  const llm = await classifyWithLlm(stripAddress(rawText, botName), intentCfg, ctx);
  if (llm) return llm;
  const { confident: _c, ...intent } = gate;
  return intent;
}
