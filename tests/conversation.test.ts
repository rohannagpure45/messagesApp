import { describe, it, expect, afterEach } from "vitest";
import { ConversationStore, toContext, nextTurn, __setClock } from "../src/sawa/conversation";
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

  it("shares one thread's state across senders (keyed by space, not sender)", () => {
    __setClock(() => 0);
    const store = new ConversationStore();
    const s = state();
    store.set("group-1", s);
    expect(store.get("group-1")).toBe(s); // any member reading the same space sees the same cursor
  });
});

describe("toContext", () => {
  it("reports no active market for null or empty candidates", () => {
    expect(toContext(null).hasActiveMarket).toBe(false);
    expect(toContext(state({ candidates: [] })).hasActiveMarket).toBe(false);
  });

  it("summarizes the currently-shown market for the parser", () => {
    expect(toContext(state({ cursor: 1 }))).toMatchObject({
      hasActiveMarket: true,
      query: "world cup",
      currentVenue: "kalshi",
      venuesPresent: ["sawa", "kalshi"],
    });
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

  it("next → pages to the following candidate", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "next", via: "regex" }, null);
    expect(out.newState.cursor).toBe(1);
    expect(out.body).toContain("on Kalshi");
  });

  it("next at the end → reports exhaustion and holds the cursor (idempotent)", () => {
    const out = nextTurn(state({ cursor: 1 }), { kind: "next", via: "regex" }, null);
    expect(out.body.toLowerCase()).toContain("everything i've got");
    expect(out.newState.cursor).toBe(1);
  });

  it("link (venue) → hands out that venue's URL, records it linked, cursor unchanged", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "link", venue: "kalshi", via: "regex" }, null);
    expect(out.body).toContain("https://kalshi.com/e/x");
    expect(out.newState.linkedVenues.has("kalshi")).toBe(true);
    expect(out.newState.cursor).toBe(0);
  });

  it("link for a venue with no match → no-venue reply, never a fabricated URL", () => {
    const out = nextTurn(state(), { kind: "link", venue: "polymarket", via: "regex" }, null);
    expect(out.body).toContain("Polymarket");
    expect(out.body).not.toContain("http");
  });

  it("link (generic) → returns the currently-shown market's URL", () => {
    const out = nextTurn(state({ cursor: 0 }), { kind: "link", via: "regex" }, null);
    expect(out.body).toContain("https://sawapredictions.com/p/1");
  });
});
