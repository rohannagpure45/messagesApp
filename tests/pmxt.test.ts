import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { searchVenue, searchExternal, expandQueries, __setClock, __clearCache } from "../src/pmxt/discover";
import { PmxtError, __setRetryBackoffMs } from "../src/pmxt/http";
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
    resolutionDate: "2026-07-06T17:00:00.000Z",
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
  __setRetryBackoffMs(0); // don't actually sleep during retry tests
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setClock(() => Date.now());
  __setRetryBackoffMs(250);
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
    expect(vr!.closesAt).toBe(Date.parse("2026-07-06T17:00:00.000Z")); // resolutionDate → closesAt (recency)
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

describe("expandQueries (list + proper-noun entity decomposition)", () => {
  it("keeps the full query AND splits list separators into entities", () => {
    // The full query stays (genuine phrases still match), plus each list-entity is searched on its own.
    expect(expandQueries("Switzerland, India")).toEqual(["Switzerland, India", "Switzerland", "India"]);
    expect(expandQueries("Trump & Biden")).toEqual(["Trump & Biden", "Trump", "Biden"]);
    expect(expandQueries("BTC / ETH")).toEqual(["BTC / ETH", "BTC", "ETH"]);
    expect(expandQueries("cap and trade")).toEqual(["cap and trade", "cap", "trade"]);
  });

  it("decomposes a space-joined proper-noun compound into the entity that has a market", () => {
    // "Mexico Raul Jimenez player props" matches no title as a phrase; "Raul Jimenez" does.
    const xs = expandQueries("Mexico Raul Jimenez player props");
    expect(xs).toContain("Mexico Raul Jimenez player props"); // full query kept
    expect(xs).toContain("Raul Jimenez"); // the entity sub-query (adjacent proper-noun bigram)
    expect(xs).toContain("Mexico");
    expect(xs).not.toContain("player"); // lowercase tails are not entities
    expect(xs.length).toBeLessThanOrEqual(6);
  });

  it("splits a two-entity compound ('Czechia Mexico') into each country", () => {
    expect(expandQueries("Czechia Mexico")).toEqual(["Czechia Mexico", "Czechia", "Mexico"]);
  });

  it("leaves a single proper noun and plain lowercase queries unchanged", () => {
    expect(expandQueries("Czechia")).toEqual(["Czechia"]);
    expect(expandQueries("world cup")).toEqual(["world cup"]);
    expect(expandQueries("bitcoin")).toEqual(["bitcoin"]);
  });

  it("caps the number of sub-queries to bound pmxt calls/credits", () => {
    expect(expandQueries("a1, b2, c3, d4, e5").length).toBeLessThanOrEqual(6);
    expect(expandQueries("Alpha Bravo Charlie Delta Echo Foxtrot").length).toBeLessThanOrEqual(6);
  });
});

describe("getJson transient retry (via searchVenue)", () => {
  it("retries once on a transient error (timeout/network) and returns rows on the second try", async () => {
    let n = 0;
    globalThis.fetch = (() => {
      n += 1;
      if (n === 1) {
        const e = new Error("The operation was aborted");
        e.name = "AbortError"; // what an AbortController timeout throws
        return Promise.reject(e);
      }
      return Promise.resolve(res(resp([market()])));
    }) as typeof fetch;
    const rows = await searchVenue(cfg, "kalshi", "Kalshi", "la mayor", 20);
    expect(n).toBe(2); // one retry
    expect(rows).toHaveLength(1);
  });

  it("does NOT retry a definitive HTTP error (e.g. 429) — it is a real answer, not transient", async () => {
    let n = 0;
    globalThis.fetch = (() => {
      n += 1;
      return Promise.resolve(res({ error: "rate limited" }, 429));
    }) as typeof fetch;
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "x", 20)).rejects.toBeInstanceOf(PmxtError);
    expect(n).toBe(1); // no retry
  });
});

describe("searchExternal relevance is scored against the ORIGINAL query", () => {
  it("ranks a row found via a narrow sub-query against the user's full query", async () => {
    stub((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      if (url.includes("sourceExchange=kalshi") && q === "Raul Jimenez") {
        return res(resp([market({ title: "Raul Jimenez: 1+ goals", outcomes: [{ label: "Yes", price: 0.3 }] })]));
      }
      return res(resp([]));
    });
    const out = await searchExternal(cfg, "Mexico Raul Jimenez player props", 20);
    expect(out.kalshi).toHaveLength(1);
    // 2 of the 5 original-query tokens (raul, jimenez) ≈ 0.4 — NOT 1.0 (which scoring vs the
    // sub-query "Raul Jimenez" would give). This is what lets the RELEVANCE_MIN floor pass it.
    expect(out.kalshi[0]!.relevance).toBeCloseTo(0.4, 2);
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
