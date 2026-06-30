import { describe, it, expect, afterEach } from "vitest";
import { ConversationStore, toContext, nextTurn, clarifyState, resolveClarifyTurn, pickedAnswer, __setClock } from "../src/sawa/conversation";
import type { ClarifyQuestion } from "../src/sawa/clarify";
import type { ConversationState } from "../src/sawa/conversation";
import type { Intent } from "../src/sawa/intent";
import type { SearchResults } from "../src/search";
import type { VenueResult } from "../src/venue";

const sawaRow = (over: Partial<VenueResult> = {}): VenueResult => ({
  venue: "sawa",
  sourceLabel: "Sawa",
  realMoney: false,
  title: "Who will win the World Cup?",
  url: "https://sawapredictions.com/p/1",
  top: { label: "Brazil", oddsPct: 59 },
  relevance: 1,
  ...over,
});
const kalshiRow = (over: Partial<VenueResult> = {}): VenueResult => ({
  venue: "kalshi",
  sourceLabel: "Kalshi",
  realMoney: true,
  title: "World Cup - Brazil?",
  url: "https://kalshi.com/e/x",
  top: { label: "Brazil", price: 0.22 },
  relevance: 1,
  ...over,
});

const state = (over: Partial<ConversationState> = {}): ConversationState => ({
  query: "world cup",
  candidates: [sawaRow(), kalshiRow()],
  cursor: 0,
  linkedVenues: new Set(),
  venuesPresent: ["sawa", "kalshi"],
  externalUnavailable: false,
  updatedAt: 0,
  ...over,
});

const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  query: "world cup",
  sawa: [sawaRow()],
  kalshi: [],
  polymarket: [],
  empty: false,
  truncated: false,
  externalUnavailable: false,
  externalErrored: false,
  ...over,
});

afterEach(() => __setClock(() => Date.now()));

describe("ConversationStore", () => {
  it("round-trips state by space id and misses cleanly", () => {
    __setClock(() => 1000);
    const store = new ConversationStore();
    const s = state();
    store.set("space-1", s);
    expect(store.get("space-1")).toBe(s);
    expect(store.get("missing")).toBeUndefined();
  });

  it("stamps updatedAt on set", () => {
    __setClock(() => 4242);
    const store = new ConversationStore();
    const s = state({ updatedAt: 0 });
    store.set("a", s);
    expect(s.updatedAt).toBe(4242);
  });

  it("evicts the least-recently-used thread past the cap", () => {
    __setClock(() => 0);
    const store = new ConversationStore(2, 1_000_000);
    store.set("a", state());
    store.set("b", state());
    expect(store.get("a")).toBeDefined(); // touch "a" → LRU order is now [b, a]
    store.set("c", state()); // pushes "c"; evicts the LRU, which is "b"
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });

  it("expires state past the TTL (evict on read)", () => {
    let t = 0;
    __setClock(() => t);
    const store = new ConversationStore(10, 1000);
    store.set("a", state());
    t = 999;
    expect(store.get("a")).toBeDefined();
    t = 1000;
    expect(store.get("a")).toBeUndefined();
  });

  it("isolates state by the opaque key — per-sender keys in one space stay distinct", () => {
    // index.ts keys this PER (space, sender) via sessionKey(), so members don't share a cursor.
    __setClock(() => 0);
    const store = new ConversationStore();
    const a = state({ query: "alice topic" });
    const b = state({ query: "bob topic" });
    store.set("group-1 +alice", a);
    store.set("group-1 +bob", b);
    expect(store.get("group-1 +alice")).toBe(a); // each member's thread is independent
    expect(store.get("group-1 +bob")).toBe(b);
    expect(store.get("group-1")).toBeUndefined(); // a bare space id is not a per-sender session key
  });
});

describe("toContext", () => {
  it("reports no active market for null or empty candidates", () => {
    expect(toContext(null).hasActiveMarket).toBe(false);
    expect(toContext(state({ candidates: [] })).hasActiveMarket).toBe(false);
  });

  it("summarizes the currently-shown market for the parser, incl. facts for the answer action", () => {
    const ctx = toContext(state({ cursor: 1 }));
    expect(ctx).toMatchObject({
      hasActiveMarket: true,
      query: "world cup",
      currentVenue: "kalshi",
      venuesPresent: ["sawa", "kalshi"],
    });
    expect(ctx.currentMarketFacts).toContain("World Cup - Brazil?"); // the kalshiRow title, for grounding
    expect(ctx.currentMarketFacts).toContain("venue Kalshi");
  });
});

const searchIntent = (q = "world cup"): Intent => ({ kind: "search", query: q, via: "regex" });

describe("nextTurn", () => {
  it("search → fresh state at cursor 0, shows the lead market (no disclaimer)", () => {
    const out = nextTurn(null, searchIntent(), results());
    expect(out.newState.cursor).toBe(0);
    expect(out.newState.candidates).toHaveLength(1);
    expect(out.body).toContain("Who will win the World Cup?");
    expect(out.body.toLowerCase()).not.toContain("no cash value");
  });

  it("search with no Sawa market but an external match → leads with that venue, not empty-state", () => {
    const out = nextTurn(null, searchIntent(), results({ sawa: [], kalshi: [kalshiRow()] }));
    expect(out.body.toLowerCase()).not.toContain("no live markets");
    expect(out.body).toContain("on Kalshi");
    expect(out.newState.candidates).toHaveLength(1);
    expect(out.newState.candidates[0]!.venue).toBe("kalshi");
  });

  it("search with empty results → empty-state reply + minimal state (a follow-up stays graceful)", () => {
    const out = nextTurn(null, searchIntent("dogecoin"), results({ empty: true, sawa: [], query: "dogecoin" }));
    expect(out.body.toLowerCase()).toContain("no live markets");
    expect(out.newState.candidates).toEqual([]);
  });

  it("next → pages to the following candidate (and carries no link)", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "next", via: "regex" }, null);
    expect(out.newState.cursor).toBe(1);
    expect(out.body).toContain("on Kalshi");
    expect(out.link).toBeUndefined(); // only link turns carry a link → no spurious URL message
  });

  it("next at the end → reports exhaustion and holds the cursor (idempotent)", () => {
    const out = nextTurn(state({ cursor: 1 }), { kind: "next", via: "regex" }, null);
    expect(out.body.toLowerCase()).toContain("everything i've got");
    expect(out.newState.cursor).toBe(1);
  });

  it("link (venue) → carries that venue's market as `link` (URL out of `body`), records it linked, cursor unchanged", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "link", venue: "kalshi", via: "regex" }, null);
    expect(out.link?.url).toBe("https://kalshi.com/e/x"); // the URL is handed to the caller to send as a rich card
    expect(out.link?.venue).toBe("kalshi");
    expect(out.body).not.toContain("http"); // …NOT embedded in the line (a buried URL won't unfurl)
    expect(out.body).toContain("Kalshi");
    expect(out.newState.linkedVenues.has("kalshi")).toBe(true);
    expect(out.newState.cursor).toBe(0);
  });

  it("link for a venue with no match → no-venue reply, no `link`, never a fabricated URL", () => {
    const out = nextTurn(state(), { kind: "link", venue: "polymarket", via: "regex" }, null);
    expect(out.body).toContain("Polymarket");
    expect(out.body).not.toContain("http");
    expect(out.link).toBeUndefined();
  });

  it("link (generic) → carries the currently-shown market as `link`", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "link", via: "regex" }, null);
    expect(out.link?.url).toBe("https://sawapredictions.com/p/1");
  });
});

describe("clarify turns", () => {
  const candidates = [
    sawaRow({ title: "Bitcoin dominance above 60%", url: "https://sawapredictions.com/p/9" }),
    kalshiRow({ title: "Bitcoin price on Dec 31", url: "https://kalshi.com/e/btc" }),
  ];
  const question: ClarifyQuestion = {
    question: 'Which "bitcoin" market did you mean?',
    options: [
      { label: "Dominance 60%", result: candidates[0]! },
      { label: "Price Dec 31", result: candidates[1]! },
    ],
  };

  it("clarifyState carries the candidates + the pending question bound to the asker (no market shown yet)", () => {
    const s = clarifyState("bitcoin", candidates, results({ sawa: [candidates[0]!], kalshi: [candidates[1]!] }), question, "+15550000001");
    expect(s.pending).toBe(question);
    expect(s.pendingBy).toBe("+15550000001"); // bound so a bystander can't answer
    expect(s.candidates).toHaveLength(2);
    expect(s.cursor).toBe(0);
    expect(s.query).toBe("bitcoin");
  });

  it("resolveClarifyTurn shows the chosen market, points the cursor at it, and clears pending + pendingBy", () => {
    const s = clarifyState("bitcoin", candidates, results({ sawa: [candidates[0]!], kalshi: [candidates[1]!] }), question, "+15550000001");
    const out = resolveClarifyTurn(s, question.options[1]!); // the user picked the Kalshi market
    expect(out.body).toContain("Bitcoin price on Dec 31");
    expect(out.body).toContain("on Kalshi");
    expect(out.newState.cursor).toBe(1);
    expect(out.newState.pending).toBeUndefined();
    expect(out.newState.pendingBy).toBeUndefined();
  });

  it("resolveClarifyTurn shows the option's OWN market when it isn't in the current candidates (no candidates[0] substitution)", () => {
    const stale = clarifyState("bitcoin", [kalshiRow({ title: "Some other market" })], results(), question, "+15550000001");
    const out = resolveClarifyTurn(stale, question.options[0]!); // option.result is NOT in `stale.candidates`
    expect(out.body).toContain("Bitcoin dominance above 60%"); // the tapped market, not candidates[0]
    expect(out.body).not.toContain("Some other market");
  });

  it("pickedAnswer shows the LLM-chosen market (not candidates[0]) and points the cursor at it", () => {
    // The filter narrowed to the Kalshi market; candidates[0] is the Sawa one. Show the chosen.
    const out = pickedAnswer("bitcoin", candidates, results({ sawa: [candidates[0]!], kalshi: [candidates[1]!] }), candidates[1]!);
    expect(out.body).toContain("Bitcoin price on Dec 31");
    expect(out.body).not.toContain("Bitcoin dominance"); // candidates[0] was NOT shown
    expect(out.newState.cursor).toBe(1);
    expect(out.newState.pending).toBeUndefined();
  });
});
