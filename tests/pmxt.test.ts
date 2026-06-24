import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { searchVenue, searchExternal, expandQueries, __setClock, __clearCache } from "../src/pmxt/discover";
import type { PmxtConfig } from "../src/sawa/config";

const cfg: PmxtConfig = { apiKey: "test-key", baseUrl: "https://api.pmxt.dev", builderMode: false };

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    json: async () => body,
  } as unknown as Response;
}

function stub(handler: (url: string) => Response): void {
  calls = [];
  globalThis.fetch = ((url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url)));
  }) as typeof fetch;
}

function market(over: Record<string, unknown> = {}) {
  return {
    marketId: "m1",
    sourceExchange: "kalshi",
    title: "Who will win Los Angeles Mayoral Election?",
    url: "https://kalshi.com/events/x",
    image: "https://img.example/x.png",
    volume24h: 1000,
    outcomes: [
      { label: "Karen Bass", price: 0.65 },
      { label: "Nithya Raman", price: 0.34 },
    ],
    ...over,
  };
}
const resp = (markets: unknown[]) => ({ data: markets, meta: { count: markets.length, limit: 20, offset: 0 } });

beforeEach(() => {
  __clearCache();
  __setClock(() => 0);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setClock(() => Date.now());
});

describe("searchVenue", () => {
  it("builds the verified pmxt request (q + sourceExchange + closed=false + limit, Bearer auth)", async () => {
    stub(() => res(resp([market()])));
    await searchVenue(cfg, "kalshi", "Kalshi", "la mayor", 20);
    const c = calls[0]!;
    expect(c.url).toContain("https://api.pmxt.dev/v0/markets");
    expect(c.url).toContain("q=la+mayor"); // `q`, not `query`
    expect(c.url).toContain("sourceExchange=kalshi"); // venue filter == response field name
    expect(c.url).toContain("closed=false");
    expect(c.url).toContain("limit=20");
    expect(c.init.method).toBe("GET");
    expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("maps a UnifiedMarket to a VenueResult and picks the highest affirmative outcome (favorite)", async () => {
    stub(() => res(resp([market()])));
    const [vr] = await searchVenue(cfg, "kalshi", "Kalshi", "la mayor", 20);
    expect(vr).toMatchObject({
      venue: "kalshi",
      sourceLabel: "Kalshi",
      realMoney: true,
      title: "Who will win Los Angeles Mayoral Election?",
      url: "https://kalshi.com/events/x",
      imageUrl: "https://img.example/x.png",
      volume24h: 1000,
      top: { label: "Karen Bass", price: 0.65 },
    });
    expect(vr!.relevance).toBeGreaterThan(0);
  });

  it("prefers the AFFIRMATIVE outcome over a higher-priced 'Not …' side", async () => {
    stub(() =>
      res(
        resp([
          market({
            outcomes: [
              { label: "Not Germany", price: 0.99 },
              { label: "Germany", price: 0.01 },
            ],
          }),
        ]),
      ),
    );
    const [vr] = await searchVenue(cfg, "kalshi", "Kalshi", "germany", 20);
    expect(vr!.top).toEqual({ label: "Germany", price: 0.01 });
  });

  it("caches per (venue, query) within the TTL and refetches after it expires", async () => {
    let t = 0;
    __setClock(() => t);
    stub(() => res(resp([market()])));
    await searchVenue(cfg, "kalshi", "Kalshi", "x", 20);
    await searchVenue(cfg, "kalshi", "Kalshi", "x", 20); // within TTL → served from cache
    expect(calls.length).toBe(1);
    t += 61_000; // past the 60s TTL
    await searchVenue(cfg, "kalshi", "Kalshi", "x", 20);
    expect(calls.length).toBe(2);
  });
});

describe("expandQueries (multi-entity list splitting)", () => {
  it("keeps the full query AND splits list separators into entities", () => {
    // The full query stays (genuine phrases still match), plus each list-entity is searched on its own.
    expect(expandQueries("Switzerland, India")).toEqual(["Switzerland, India", "Switzerland", "India"]);
    expect(expandQueries("Trump & Biden")).toEqual(["Trump & Biden", "Trump", "Biden"]);
    expect(expandQueries("BTC / ETH")).toEqual(["BTC / ETH", "BTC", "ETH"]);
    expect(expandQueries("cap and trade")).toEqual(["cap and trade", "cap", "trade"]);
  });

  it("leaves single-entity / phrase queries unchanged (spaces and 'vs' are NOT separators)", () => {
    expect(expandQueries("world cup")).toEqual(["world cup"]);
    expect(expandQueries("FIFA World Cup")).toEqual(["FIFA World Cup"]);
    expect(expandQueries("Switzerland vs Canada")).toEqual(["Switzerland vs Canada"]);
  });

  it("caps the number of sub-queries to bound pmxt calls/credits", () => {
    expect(expandQueries("a1, b2, c3, d4, e5").length).toBeLessThanOrEqual(4);
  });
});

describe("searchExternal (fail-soft + multi-entity merge)", () => {
  it("returns the venue that succeeds even when the other errors (e.g. 429)", async () => {
    stub((url) =>
      url.includes("sourceExchange=kalshi")
        ? res({ error: "rate limited" }, 429)
        : res(resp([market({ sourceExchange: "polymarket", title: "Poly bitcoin market" })])),
    );
    const out = await searchExternal(cfg, "bitcoin", 20);
    expect(out.kalshi).toEqual([]); // 429 → degraded to empty, no throw
    expect(out.polymarket).toHaveLength(1);
    expect(out.polymarket[0]!.venue).toBe("polymarket");
  });

  it("searches each list-entity and merges results per venue (the 'Switzerland, India' bug)", async () => {
    // Mirror real pmxt: the comma phrase matches nothing; each single entity returns one market.
    stub((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      const venue = url.includes("sourceExchange=kalshi") ? "kalshi" : "polymarket";
      if (q.includes(",")) return res(resp([])); // multi-entity phrase → no match (as observed live)
      return res(resp([market({ sourceExchange: venue, title: `${venue} ${q}`, url: `https://x/${venue}/${q}` })]));
    });
    const out = await searchExternal(cfg, "Switzerland, India", 20);
    expect(out.kalshi.map((r) => r.title).sort()).toEqual(["kalshi India", "kalshi Switzerland"]);
    expect(out.polymarket.map((r) => r.title).sort()).toEqual(["polymarket India", "polymarket Switzerland"]);
  });

  it("de-dupes a market returned by more than one sub-query", async () => {
    stub((url) => {
      const venue = url.includes("sourceExchange=kalshi") ? "kalshi" : "polymarket";
      return res(resp([market({ sourceExchange: venue, title: "Same Market", url: "https://x/same" })]));
    });
    const out = await searchExternal(cfg, "Switzerland, India", 20); // 3 sub-queries, identical market each
    expect(out.kalshi).toHaveLength(1);
    expect(out.polymarket).toHaveLength(1);
  });
});
