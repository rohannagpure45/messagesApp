/**
 * Per-conversation memory + the follow-up state machine for the conversational SEARCH face.
 *
 * Spectrum is a forward message stream with no per-thread history, so to answer follow-ups ("not
 * that" / "send the kalshi link") we keep a small, durable summary of the last search per
 * conversation: the flat cross-venue candidate list, a cursor (which market was shown), and which
 * venues exist. `ConversationStore` is a bounded LRU+TTL map keyed by `Space.id` — a twin of
 * routing.ts `SeenSet` — so memory stays flat for a long-running daemon (process-only; no DB, honoring
 * the GET-only/no-writes invariant).
 *
 * The transition logic lives in the PURE `nextTurn(state, intent, results)` reducer (no Spectrum), so
 * the five-way state machine is fully unit-testable. index.ts does the I/O: read state → parse intent
 * with `toContext(state)` → `nextTurn` → send `body` + persist `newState`.
 */
import type { Venue, VenueResult } from "../venue";
import type { Intent, FollowupContext } from "./intent";
import { type SearchResults, flattenRanked, venuesPresent } from "../search";
import type { ClarifyQuestion, ClarifyOption } from "./clarify";
import { renderOne, renderLink, renderExhausted, renderNoVenue, emptyReply, marketFacts } from "./cards";

export interface ConversationState {
  /** The active search subject (cleaned). */
  query: string;
  /** The flat cross-venue ranked candidate list — index 0 is the market shown first. */
  candidates: VenueResult[];
  /** Index of the currently-shown market in `candidates`. */
  cursor: number;
  /** Venues whose link was already handed out this thread (analytics / future de-dupe). */
  linkedVenues: Set<Venue>;
  /** Venues that returned ≥1 market this search — so a venue-link follow-up knows what exists. */
  venuesPresent: Venue[];
  /** True when pmxt enrichment was unavailable (Sawa-only) — distinguishes "off" from "no match". */
  externalUnavailable: boolean;
  /**
   * A clarifying question awaiting the user's pick (poll tap or text reply). Present ONLY between
   * asking "which market?" and resolving the answer; cleared the moment a choice lands or a new search
   * overwrites the thread. Drives the resolve-first branch in the handler.
   */
  pending?: ClarifyQuestion;
  /**
   * Normalized handle of the person the pending clarify was asked of (the one who hailed). A TEXT
   * answer is bound to them, so in a shared space (a group, or local mode reading the whole inbox) a
   * bystander's unhailed "2" can't resolve someone else's question. Paired with `pending`.
   */
  pendingBy?: string;
  /** Last-touched wall-clock ms — drives TTL eviction (stamped by the store on `set`). */
  updatedAt: number;
}

/** What a turn produced: the reply text to send, and the state to persist. */
export interface TurnOutcome {
  body: string;
  newState: ConversationState;
}

export interface NextTurnOptions {
  /** Append the folk-tone flourish (SAWA_FOLK_TONE). */
  folkTone?: boolean;
}

const DEFAULT_MAX = 500;
const DEFAULT_TTL_MS = 30 * 60_000; // 30 minutes — long enough for a real back-and-forth.

/** Injectable clock so tests are deterministic (mirrors pmxt/discover.ts). */
let now: () => number = () => Date.now();
export function __setClock(fn: () => number): void {
  now = fn;
}

/**
 * Bounded LRU + TTL store of per-conversation state, keyed by an OPAQUE string the caller supplies.
 * Lazy TTL (evict-on-read) plus an LRU touch on read and a FIFO eviction past `max` keep memory flat
 * without a timer. The key is generic; `index.ts` keys it PER (space, sender) via `sessionKey()` — so
 * each member keeps their own thread/cursor and a hail by one member doesn't relax the whole space.
 * (Originally per-`Space.id`; the per-sender keying landed with the conversational rearrange.)
 */
export class ConversationStore {
  private readonly map = new Map<string, ConversationState>();
  private readonly queue: string[] = []; // LRU order; back = most-recently-used.

  constructor(
    private readonly max = DEFAULT_MAX,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  /** Current state for a conversation, or undefined when absent or expired (evicted lazily on read). */
  get(spaceId: string): ConversationState | undefined {
    const state = this.map.get(spaceId);
    if (!state) return undefined;
    if (now() - state.updatedAt >= this.ttlMs) {
      this.drop(spaceId);
      return undefined;
    }
    this.touch(spaceId);
    return state;
  }

  /** Upsert state, stamping `updatedAt` and bounding the map to `max` (FIFO eviction of the LRU). */
  set(spaceId: string, state: ConversationState): void {
    state.updatedAt = now();
    const isNew = !this.map.has(spaceId);
    this.map.set(spaceId, state);
    if (isNew) {
      this.queue.push(spaceId);
      while (this.queue.length > this.max) {
        const evicted = this.queue.shift();
        if (evicted !== undefined && evicted !== spaceId) this.map.delete(evicted);
      }
    } else {
      this.touch(spaceId);
    }
  }

  private touch(spaceId: string): void {
    const i = this.queue.indexOf(spaceId);
    if (i !== -1) {
      this.queue.splice(i, 1);
      this.queue.push(spaceId);
    }
  }

  private drop(spaceId: string): void {
    this.map.delete(spaceId);
    const i = this.queue.indexOf(spaceId);
    if (i !== -1) this.queue.splice(i, 1);
  }
}

/** Build the typed digest the intent parser consumes from the current state (or "no active market"). */
export function toContext(state: ConversationState | null | undefined): FollowupContext {
  if (!state || state.candidates.length === 0) {
    return { hasActiveMarket: false, venuesPresent: state?.venuesPresent ?? [] };
  }
  const current = state.candidates[clampCursor(state)];
  return {
    hasActiveMarket: true,
    query: state.query,
    currentVenue: current?.venue,
    venuesPresent: state.venuesPresent,
    currentMarketFacts: current ? marketFacts(current) : undefined,
  };
}

/** Clamp the cursor into range (defensive — `next` keeps it valid, but state can outlive a shrink). */
function clampCursor(state: ConversationState): number {
  return Math.max(0, Math.min(state.cursor, state.candidates.length - 1));
}

function emptyState(query: string): ConversationState {
  return {
    query,
    candidates: [],
    cursor: 0,
    linkedVenues: new Set(),
    venuesPresent: [],
    externalUnavailable: false,
    updatedAt: 0,
  };
}

/**
 * The pure follow-up reducer. Handles `search` (build fresh state from a fresh `results`), `next`
 * (page the cursor), and `link` (venue-scoped or current). `other` is handled by the caller and never
 * reaches here. `updatedAt` is left for the store to stamp on `set`.
 */
export function nextTurn(
  state: ConversationState | null,
  intent: Intent,
  results: SearchResults | null,
  opts: NextTurnOptions = {},
): TurnOutcome {
  switch (intent.kind) {
    case "search":
      return onSearch(intent, results, opts);
    case "next":
      return onNext(state, opts);
    case "link":
      return onLink(state, intent);
    default:
      return { body: "", newState: state ?? emptyState(intent.query ?? "") };
  }
}

/** A new search overwrites the thread: rebuild candidates, reset cursor + linked venues. */
function onSearch(intent: Intent, results: SearchResults | null, opts: NextTurnOptions): TurnOutcome {
  const query = (results?.query || intent.query) ?? "";
  const candidates = results && !results.empty ? flattenRanked(results) : [];
  if (!results || results.empty || candidates.length === 0) {
    return {
      body: emptyReply(query, results?.externalErrored ?? false),
      newState: {
        ...emptyState(query),
        venuesPresent: results ? venuesPresent(results) : [],
        externalUnavailable: results?.externalUnavailable ?? false,
      },
    };
  }
  return {
    body: renderOne(candidates[0]!, opts),
    newState: {
      query,
      candidates,
      cursor: 0,
      linkedVenues: new Set(),
      venuesPresent: venuesPresent(results),
      externalUnavailable: results.externalUnavailable,
      updatedAt: 0,
    },
  };
}

/** "not that" / "another": page to the next candidate, or report exhaustion (idempotent at the end). */
function onNext(state: ConversationState | null, opts: NextTurnOptions): TurnOutcome {
  if (!state || state.candidates.length === 0) {
    return { body: renderExhausted(state?.query ?? ""), newState: state ?? emptyState("") };
  }
  const nextCursor = state.cursor + 1;
  if (nextCursor >= state.candidates.length) {
    return { body: renderExhausted(state.query), newState: { ...state } }; // cursor held → repeatable
  }
  return { body: renderOne(state.candidates[nextCursor]!, opts), newState: { ...state, cursor: nextCursor } };
}

/** "send the kalshi link" / bare "link": hand out a market URL — venue-scoped or the current one. */
function onLink(state: ConversationState | null, intent: Intent): TurnOutcome {
  if (!state || state.candidates.length === 0) {
    return { body: renderExhausted(state?.query ?? ""), newState: state ?? emptyState("") };
  }
  if (intent.venue) {
    const target = state.candidates.find((c) => c.venue === intent.venue);
    if (!target || !target.url) {
      return { body: renderNoVenue(intent.venue, state.query), newState: { ...state } };
    }
    return { body: renderLink(target), newState: linkOf(state, intent.venue) };
  }
  // Generic "link" → the currently-shown market's URL.
  const current = state.candidates[clampCursor(state)]!;
  if (!current.url) {
    return { body: renderNoVenue(current.venue, state.query), newState: { ...state } };
  }
  return { body: renderLink(current), newState: linkOf(state, current.venue) };
}

/** Clone state with `venue` recorded as linked (cursor unchanged — a link is a side-quest). */
function linkOf(state: ConversationState, venue: Venue): ConversationState {
  return { ...state, linkedVenues: new Set(state.linkedVenues).add(venue) };
}

/**
 * Build the thread state for a clarify turn: the full ranked candidates are kept (so "another" / link
 * follow-ups still work once a choice is made) plus the `pending` question. The reply (the poll / text
 * list) is produced by the caller from `question`; this only assembles state. `cursor` is 0 but no
 * single market has been "shown" yet — resolution sets the cursor to the chosen market.
 */
export function clarifyState(
  query: string,
  candidates: VenueResult[],
  results: SearchResults,
  question: ClarifyQuestion,
  pendingBy: string,
): ConversationState {
  return {
    query,
    candidates,
    cursor: 0,
    linkedVenues: new Set(),
    venuesPresent: venuesPresent(results),
    externalUnavailable: results.externalUnavailable,
    pending: question,
    pendingBy,
    updatedAt: 0,
  };
}

/**
 * Show a single chosen market as the fresh answer (no pending question) — used when the LLM clarify
 * filter narrows the candidates down to ONE genuinely-relevant market, so we answer with THAT market
 * rather than falling back to `candidates[0]` (which could be the noise the filter just rejected). The
 * cursor points at the chosen market so "another" / "send the link" continue from there.
 */
export function pickedAnswer(
  query: string,
  candidates: VenueResult[],
  results: SearchResults,
  chosen: VenueResult,
  opts: NextTurnOptions = {},
): TurnOutcome {
  const idx = Math.max(0, candidates.indexOf(chosen));
  return {
    body: renderOne(candidates[idx] ?? chosen, opts),
    newState: {
      query,
      candidates,
      cursor: idx,
      linkedVenues: new Set(),
      venuesPresent: venuesPresent(results),
      externalUnavailable: results.externalUnavailable,
      updatedAt: 0,
    },
  };
}

/**
 * Resolve a clarify answer: show the chosen market (folk-style line), point the cursor at it so a
 * later "another" / "send the link" continues from there, and CLEAR `pending`. Pure — the caller
 * resolves the option (via `clarify.resolveAnswer`) and persists `newState`.
 */
export function resolveClarifyTurn(
  state: ConversationState,
  option: ClarifyOption,
  opts: NextTurnOptions = {},
): TurnOutcome {
  // Show the option's OWN market. Only sync the cursor when that market is in the current candidates;
  // if it isn't (e.g. a stale poll tapped after a new search replaced the list), show it directly
  // rather than silently substituting candidates[0] (the `?? candidates[0]` bug the review caught).
  const idx = state.candidates.indexOf(option.result);
  const chosen = idx >= 0 ? state.candidates[idx]! : option.result;
  const cursor = idx >= 0 ? idx : state.cursor;
  return { body: renderOne(chosen, opts), newState: { ...state, cursor, pending: undefined, pendingBy: undefined } };
}
