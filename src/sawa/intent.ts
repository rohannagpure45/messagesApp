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
import OpenAI from "openai";
import type { IntentConfig } from "./config";

export type IntentKind = "search" | "other";

export interface Intent {
  kind: IntentKind;
  /** The cleaned search subject (e.g. "FIFA World Cup"). Present when kind === "search". */
  query?: string;
  /** Which stage decided this — useful for analytics/debugging. */
  via: "regex" | "llm" | "fallback";
}

const MAX_QUERY_LEN = 120;

/** Leading address tokens to strip: "sawa", "@sawa", "hey sawa,", "sawa:" … */
function stripAddress(text: string, botName: string): string {
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

// Explicit search triggers + the phrase to peel off to get the subject.
const SEARCH_TRIGGERS: { re: RegExp; strip: RegExp }[] = [
  { re: /^(find|search|lookup|look up|show me|show|get me)\b/i, strip: /^(find|search|lookup|look up|show me|show|get me)\b\s*/i },
  { re: /\bwhere can i (bet|trade|wager)( on)?\b/i, strip: /^.*\bwhere can i (bet|trade|wager)( on)?\b\s*/i },
  { re: /\b(bet|trade|wager) on\b/i, strip: /^.*\b(bet|trade|wager) on\b\s*/i },
  { re: /\bodds (on|for|of)\b/i, strip: /^.*\bodds (on|for|of)\b\s*/i },
  { re: /\b(markets?|predictions?) (on|for|about)\b/i, strip: /^.*\b(markets?|predictions?) (on|for|about)\b\s*/i },
  { re: /\b(is there|are there|any) (a )?markets?\b/i, strip: /^.*\b(is there|are there|any) (a )?markets?\b( on| for| about)?\s*/i },
];

/** Trim trailing filler/punctuation and a leading article from an extracted subject. */
function cleanQuery(s: string): string {
  return s
    .replace(/[?!.]+$/g, "")
    .replace(/\bmarkets?\??$/i, "")
    .replace(/\b(please|pls|plz|thanks?|thx)\b/gi, "")
    .replace(/^\s*(the|a|an)\s+/i, "") // leading article: "the FIFA World Cup" → "FIFA World Cup"
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

const SYSTEM_PROMPT =
  "You classify a single chat message sent to a prediction-market assistant. " +
  'Return ONLY JSON: {"kind":"search"|"other","query":string}. ' +
  '"search" = the user wants to find/see prediction markets or odds on a topic. ' +
  '"other" = greeting, small talk, account/balance, help, or a request to CREATE a market. ' +
  'For "search", set "query" to the clean topic only — strip filler like "sawa", "find", ' +
  '"where can I bet on", "odds on", "markets for", and trailing punctuation. ' +
  'For "other", set "query" to "".';

interface RawLlm {
  kind?: unknown;
  query?: unknown;
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

async function classifyWithLlm(text: string, cfg: IntentConfig): Promise<Intent | null> {
  try {
    const resp = await getClient(cfg).chat.completions.create(
      {
        model: cfg.model,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 400) },
        ],
      },
      { timeout: 6_000 },
    );
    const content = resp.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as RawLlm;
    const kind: IntentKind = parsed.kind === "search" ? "search" : "other";
    if (kind === "other") return { kind, via: "llm" };
    const query = typeof parsed.query === "string" ? cleanQuery(parsed.query) : "";
    if (query.length < 2) return null; // unusable — let the caller keep the regex guess
    return { kind: "search", query, via: "llm" };
  } catch (err) {
    console.warn(`[intent] LLM classify failed — using regex gate. ${(err as Error).message}`);
    return null;
  }
}

/**
 * Parse a message into an Intent. Uses the regex gate first; only consults the LLM when the gate
 * is unsure and `intentCfg` is provided. Always resolves — never throws.
 */
export async function parseIntent(
  rawText: string,
  botName: string,
  intentCfg: IntentConfig | null,
): Promise<Intent> {
  const gate = classify(rawText, botName);
  if (gate.confident || !intentCfg) {
    const { confident: _c, ...intent } = gate;
    return intent;
  }
  const llm = await classifyWithLlm(stripAddress(rawText, botName), intentCfg);
  if (llm) return llm;
  const { confident: _c, ...intent } = gate;
  return intent;
}
