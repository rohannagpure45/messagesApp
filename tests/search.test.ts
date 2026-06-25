import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSearch, isBroadQuery, flattenRanked, venuesPresent, __setClock as __setSearchClock } from "../src/search";
import { __clearCache, __setClock } from "../src/pmxt/discover";
import type { SearchResults } from "../src/search";
import type { Config, PmxtConfig } from "../src/sawa/config";

const config: Config = {
  apiBaseUrl: "https://sawa.test",
  marketUrlTemplate: "https://sawa.test/predictions/{id}",
  botName: "sawa",
};
const pmxt: PmxtConfig = { apiKey: "k", baseUrl: "https://api.pmxt.dev", builderMode: false };

const realFetch = globalThis.fetch;

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: `S${status}`, json: async () => body } as unknown as Response;
}

/** A Sawa feed row (per-option pool at bets[0].amount, total at volume). */
function feedRow(id: string, title: string, pools: Record<string, number>) {
  const volume = Object.values(pools).reduce((s, n) => s + n, 0);
  return {
    id,
    title,
    category: "sports",
    deadline: "2026-07-01T00:00:00Z",
    resolved: false,
    isPrivate: false,
    volume,
    options: Object.entries(pools).map(([label, amount], i) => ({ id: `${id}o${i}`, label, bets: [{ amount }] })),
  };
}
const sawaFeed = (rows: unknown[]) => ({ predictions: rows, pagination: { page: 1, limit: 100, total: rows.length, pages: 1 } });

/** A pmxt market with one affirmative outcome at `price`. */
function pmxtMarket(exchange: string, title: string, label: string, price: number, volume24h = 1, resolutionDate?: string) {
  return {
    marketId: `${exchange}-${label}`,
    sourceExchange: exchange,
    title,
    url: `https://${exchange}.com/${label}`,
    volume24h,
    resolutionDate,
    outcomes: [
      { label, price },
      { label: `Not ${label}`, price: 1 - price },
    ],
  };
}

interface StubVenues {
  sawa?: unknown[];
  kalshi?: unknown[];
  polymarket?: unknown[];
  pmxtError?: boolean;
}

function installStub(v: StubVenues) {
  globalThis.fetch = ((url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/predictions")) return Promise.resolve(res(sawaFeed(v.sawa ?? [])));
    if (u.includes("api.pmxt.dev")) {
      if (v.pmxtError) return Promise.resolve(res({ error: "rate limited" }, 429));
      const ex = u.includes("sourceExchange=kalshi") ? "kalshi" : "polymarket";
      return Promise.resolve(res({ data: v[ex] ?? [], meta: {} }));
    }
    return Promise.resolve(res({}, 404));
  }) as typeof fetch;
}

beforeEach(() => {
  __clearCache();
  __setClock(() => 0);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setClock(() => Date.now());
  __setSearchClock(() => Date.now());
});

describe("runSearch", () => {
  it("merges Sawa + Kalshi + Polymarket and surfaces the favorite ahead of longshots", async () => {
    installStub({
      sawa: [feedRow("s1", "Who will win the World Cup?", { Brazil: 59, Argentina: 41 })],
      kalshi: [
        pmxtMarket("kalshi", "World Cup Winner - Will Congo DR win?", "Congo DR", 0.002, 10),
        pmxtMarket("kalshi", "World Cup Winner - Will Brazil win?", "Brazil", 0.22, 5000),
      ],
      polymarket: [pmxtMarket("polymarket", "World Cup Winner - Will France win?", "France", 0.15)],
    });

    const r = await runSearch("world cup", { config, pmxt });
    expect(r.empty).toBe(false);
    expect(r.sawa).toHaveLength(1);
    expect(r.sawa[0]!.top).toEqual({ label: "Brazil", oddsPct: 59 });
    // Favorite-first ranking: the competitive Brazil market (22¢) ahead of the Congo DR longshot (<1¢).
    expect(r.kalshi.map((m) => m.top?.label)).toEqual(["Brazil", "Congo DR"]);
    expect(r.polymarket).toHaveLength(1);
    expect(r.externalUnavailable).toBe(false);
  });

  it("ranks a competitive favorite above a near-lock (99¢) and a longshot", async () => {
    installStub({
      kalshi: [
        pmxtMarket("kalshi", "Who will win the Britain by-election?", "Labour", 0.99, 9000), // near-lock
        pmxtMarket("kalshi", "Who will win the LA mayor election?", "Karen Bass", 0.6, 100), // competitive
        pmxtMarket("kalshi", "Who will win the Peru election?", "Longshot Candidate", 0.01, 100), // longshot
      ],
    });
    const r = await runSearch("election", { config, pmxt });
    // The 60¢ competitive race leads; the 99¢ near-lock and the 1¢ longshot both sink.
    expect(r.kalshi[0]!.top!.label).toBe("Karen Bass");
  });

  it("filters Sawa markets below the relevance floor (no substring false-positives)", async () => {
    installStub({
      sawa: [
        feedRow("s1", "Who will win the World Cup?", { Brazil: 1 }),
        feedRow("s2", "Will it rain in NYC tomorrow?", { Yes: 1 }),
      ],
    });
    const r = await runSearch("world cup", { config, pmxt: null });
    expect(r.sawa.map((m) => m.title)).toEqual(["Who will win the World Cup?"]);
  });

  it("is empty when nothing matches anywhere", async () => {
    installStub({ sawa: [feedRow("s1", "Totally unrelated market", { Yes: 1 })], kalshi: [], polymarket: [] });
    const r = await runSearch("dogecoin", { config, pmxt });
    expect(r.empty).toBe(true);
    expect(r.sawa).toEqual([]);
  });

  it("flags externalUnavailable and returns Sawa-only when pmxt is not configured", async () => {
    installStub({ sawa: [feedRow("s1", "World Cup winner?", { Brazil: 1 })] });
    const r = await runSearch("world cup", { config, pmxt: null });
    expect(r.externalUnavailable).toBe(true);
    expect(r.kalshi).toEqual([]);
    expect(r.polymarket).toEqual([]);
    expect(r.sawa).toHaveLength(1);
  });

  it("is fail-soft: a pmxt error still returns the Sawa side", async () => {
    installStub({ sawa: [feedRow("s1", "World Cup winner?", { Brazil: 1 })], pmxtError: true });
    const r = await runSearch("world cup", { config, pmxt });
    expect(r.sawa).toHaveLength(1);
    expect(r.kalshi).toEqual([]);
    expect(r.polymarket).toEqual([]);
    expect(r.empty).toBe(false);
    expect(r.externalErrored).toBe(true); // the 429 is recorded, even though Sawa carried the reply
  });

  it("flags externalErrored (rate-limited) rather than implying the market is absent", async () => {
    installStub({ sawa: [], pmxtError: true }); // pmxt 429s, Sawa empty → empty result, but it's a rate-limit
    const r = await runSearch("bitcoin", { config, pmxt });
    expect(r.empty).toBe(true);
    expect(r.externalErrored).toBe(true);
  });

  it("carries a runner-up outcome for a two-sided market (folk two-sided line)", async () => {
    installStub({ sawa: [feedRow("s1", "Who will win the World Cup?", { Brazil: 59, Argentina: 41 })] });
    const r = await runSearch("world cup", { config, pmxt: null });
    expect(r.sawa[0]!.top).toEqual({ label: "Brazil", oddsPct: 59 });
    expect(r.sawa[0]!.runnerUp).toEqual({ label: "Argentina", oddsPct: 41 });
  });
});

/** A query-aware pmxt stub: the handler decides each response from the `q` sub-query + venue. */
function installQueryStub(handler: (q: string, kalshi: boolean) => unknown[]) {
  globalThis.fetch = ((url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/predictions")) return Promise.resolve(res(sawaFeed([])));
    if (u.includes("api.pmxt.dev")) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q") ?? "");
      return Promise.resolve(res({ data: handler(q, u.includes("sourceExchange=kalshi")), meta: {} }));
    }
    return Promise.resolve(res({}, 404));
  }) as typeof fetch;
}

describe("runSearch — proper-noun entity decomposition (Issue 4)", () => {
  it("surfaces an entity market a compound query only reaches via decomposition", async () => {
    // pmxt matches titles by phrase: the full compound returns nothing; only "Raul Jimenez" hits.
    installQueryStub((q, kalshi) =>
      kalshi && q === "Raul Jimenez" ? [pmxtMarket("kalshi", "Raul Jimenez: 1+ goals", "Yes", 0.3)] : [],
    );
    const r = await runSearch("Mexico Raul Jimenez player props", { config, pmxt });
    expect(r.kalshi.map((m) => m.title)).toEqual(["Raul Jimenez: 1+ goals"]);
    expect(r.empty).toBe(false);
  });

  it("drops decomposition noise via the ORIGINAL-query relevance floor", async () => {
    // The broad "Cup" sub-query pulls an unrelated "Stanley Cup" market; the real World Cup market
    // comes from the full query / "World Cup" bigram. Both are fetched; only the relevant one stays.
    installQueryStub((q, kalshi) => {
      if (!kalshi) return [];
      if (q === "Cup") return [pmxtMarket("kalshi", "Stanley Cup Winner", "Panthers", 0.5)];
      if (q === "FIFA World Cup" || q === "World Cup") return [pmxtMarket("kalshi", "World Cup Winner: Brazil?", "Brazil", 0.22)];
      return [];
    });
    const r = await runSearch("FIFA World Cup", { config, pmxt });
    // "Stanley Cup" scores 1/3 < RELEVANCE_MIN against "FIFA World Cup" → filtered; World Cup kept.
    expect(r.kalshi.map((m) => m.title)).toEqual(["World Cup Winner: Brazil?"]);
  });
});

describe("recency ranking (resolutionDate) — the Argentina miss", () => {
  it("surfaces the SOONEST upcoming market over a higher-volume later one", async () => {
    __setSearchClock(() => Date.parse("2026-06-25T00:00:00Z"));
    installStub({
      kalshi: [
        // The live miss: Austria resolves later but had ~150x the volume → won the old tiebreak.
        pmxtMarket("kalshi", "Argentina vs Austria Winner?", "Argentina", 0.86, 31_000_000, "2026-07-06T17:00:00Z"),
        pmxtMarket("kalshi", "Jordan vs Argentina Winner?", "Argentina", 0.86, 207_000, "2026-06-28T02:00:00Z"),
      ],
    });
    const flat = flattenRanked(await runSearch("Argentina", { config, pmxt }));
    expect(flat[0]!.title).toBe("Jordan vs Argentina Winner?"); // soonest upcoming leads despite far less volume
  });

  it("buries an already-resolved (past) market beneath an upcoming one", async () => {
    __setSearchClock(() => Date.parse("2026-06-25T00:00:00Z"));
    installStub({
      kalshi: [
        pmxtMarket("kalshi", "Argentina past game", "Argentina", 0.8, 9_999_999, "2026-06-20T00:00:00Z"), // resolved
        pmxtMarket("kalshi", "Argentina upcoming game", "Argentina", 0.5, 1, "2026-06-30T00:00:00Z"), // upcoming
      ],
    });
    const flat = flattenRanked(await runSearch("Argentina", { config, pmxt }));
    expect(flat[0]!.title).toBe("Argentina upcoming game");
    expect(flat[flat.length - 1]!.title).toBe("Argentina past game");
  });
});

describe("flattenRanked", () => {
  it("leads with the Sawa market when one is relevant, then pages cross-venue", async () => {
    installStub({
      sawa: [feedRow("s1", "Who will win the World Cup?", { Brazil: 59, Argentina: 41 })],
      kalshi: [pmxtMarket("kalshi", "World Cup Winner - Will Brazil win?", "Brazil", 0.22, 5000)],
      polymarket: [pmxtMarket("polymarket", "World Cup Winner - Will France win?", "France", 0.15)],
    });
    const flat = flattenRanked(await runSearch("world cup", { config, pmxt }));
    expect(flat[0]!.venue).toBe("sawa"); // Sawa leads the single conversational answer
    expect(flat).toHaveLength(3);
  });

  it("lets a clearly-more-relevant external market lead when the Sawa match is thin", async () => {
    installStub({
      sawa: [feedRow("s1", "Will the World Cup be hot?", { Yes: 1 })], // partial token overlap only
      kalshi: [pmxtMarket("kalshi", "FIFA World Cup 2026 winner - Brazil?", "Brazil", 0.22, 5000)],
    });
    const flat = flattenRanked(await runSearch("FIFA World Cup 2026", { config, pmxt }));
    expect(flat[0]!.venue).toBe("kalshi"); // beats the best Sawa match by more than the epsilon
  });

  it("returns [] for an empty result", () => {
    const empty: SearchResults = {
      query: "x",
      sawa: [],
      kalshi: [],
      polymarket: [],
      empty: true,
      truncated: false,
      externalUnavailable: false,
      externalErrored: false,
    };
    expect(flattenRanked(empty)).toEqual([]);
  });
});

describe("venuesPresent", () => {
  it("reports only the venues that returned at least one row", async () => {
    installStub({
      sawa: [feedRow("s1", "World Cup winner?", { Brazil: 1 })],
      kalshi: [pmxtMarket("kalshi", "World Cup - Brazil?", "Brazil", 0.2)],
    });
    expect(venuesPresent(await runSearch("world cup", { config, pmxt }))).toEqual(["sawa", "kalshi"]);
  });
});

describe("isBroadQuery", () => {
  it("flags short single-token queries as broad", () => {
    expect(isBroadQuery("nba")).toBe(true);
    expect(isBroadQuery("the")).toBe(true); // only a stopword → no content tokens
    expect(isBroadQuery("FIFA World Cup")).toBe(false);
  });
});
