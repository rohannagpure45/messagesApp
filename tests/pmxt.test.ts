import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  searchVenue,
  searchExternal,
  expandQueries,
  __setClock,
  __clearCache,
  __setCachePersistence,
  enableCachePersistence,
} from "../src/pmxt/discover";
import type { CachePersistence } from "../src/pmxt/discover";
import {
  PmxtError,
  PmxtRateLimitError,
  __setRetryBackoffMs,
  __setRate429BackoffMs,
  __setHttpClock,
  __resetRateGuard,
} from "../src/pmxt/http";
import type { PmxtConfig } from "../src/sawa/config";

const cfg: PmxtConfig = { apiKey: "test-key", baseUrl: "https://api.pmxt.dev", builderMode: false };

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

/** Stub Response. `headers` (optional) exposes a case-insensitive `.get` so Retry-After tests work; the
 *  real fetch Response always has `headers`, so the guarded `res.headers?.get?.()` reads it the same way. */
function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
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
  __setRate429BackoffMs(0); // ditto for the transient-429 retry backoff
  __resetRateGuard(); // clear any window/429-pause leaked from a prior case
  __setHttpClock(() => 0); // freeze the rate-guard clock too (deterministic window math)
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setClock(() => Date.now());
  __setRetryBackoffMs(250);
  __setRate429BackoffMs(200);
  __resetRateGuard();
  __setHttpClock(() => Date.now());
});

describe("durable cache & serve-stale-on-error (follow-up C)", () => {
  const CACHE_TTL_MS = 180_000;
  afterEach(() => __setCachePersistence(null));

  it("serves STALE cache when a refetch fails (instead of dropping the venue)", async () => {
    stub(() => res(resp([market({ title: "World Cup Winner" })])));
    const first = await searchVenue(cfg, "kalshi", "Kalshi", "world cup", 20);
    expect(first).toHaveLength(1);

    // Past the fresh TTL (so it refetches) but well within the 1h stale bound:
    __setClock(() => CACHE_TTL_MS + 60_000);
    stub(() => res(resp([]), 500)); // refetch fails
    const stale = await searchVenue(cfg, "kalshi", "Kalshi", "world cup", 20);

    expect(stale).toHaveLength(1); // fell back to the cached row, did NOT throw
    expect(stale[0]!.title).toBe("World Cup Winner");
    expect(calls).toHaveLength(1); // the failed refetch was actually attempted
  });

  it("re-throws (fail-soft to empty at the caller) when a fetch fails with NO cached fallback", async () => {
    stub(() => res(resp([]), 500));
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "never cached", 20)).rejects.toBeInstanceOf(PmxtError);
  });

  it("writes through to persistence on success, and rehydrates the cache on load", async () => {
    let snapshot: ReturnType<CachePersistence["load"]> = null;
    const adapter: CachePersistence = {
      load: () => snapshot,
      save: (d) => {
        snapshot = JSON.parse(JSON.stringify(d)) as typeof snapshot; // round-trip like the file adapter
      },
    };
    __setCachePersistence(adapter);
    stub(() => res(resp([market({ title: "Persisted Market" })])));
    await searchVenue(cfg, "kalshi", "Kalshi", "persist me", 20);
    expect(snapshot).not.toBeNull();
    expect(Object.keys(snapshot!)).toContain("kalshi::persist me");

    // Simulate a cold process: drop the in-memory map, rehydrate from the snapshot, and confirm the
    // next search is served from cache with NO network call (the stubbed 500 would throw otherwise).
    __clearCache();
    enableCachePersistence(adapter);
    stub(() => res(resp([]), 500));
    const hit = await searchVenue(cfg, "kalshi", "Kalshi", "persist me", 20);

    expect(hit).toHaveLength(1);
    expect(hit[0]!.title).toBe("Persisted Market");
    expect(calls).toHaveLength(0); // served from the hydrated cache
  });
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

  it("drops RESOLVED markets but KEEPS closed/inactive (still live — outcome not yet determined)", async () => {
    stub(() =>
      res(
        resp([
          market({ status: "finalized", title: "Finalized market" }), // resolved → dropped
          market({ status: "settled", title: "Settled market" }), // resolved → dropped
          market({ status: "disputed", title: "Disputed market" }), // decided (challenged) → dropped
          market({ status: "archived", title: "Archived market" }), // Polymarket terminal → dropped
          market({ status: "closed", title: "Closed awaiting determination" }), // LIVE/pending → KEPT
          market({ status: "inactive", title: "Temporarily inactive" }), // LIVE/pending → KEPT
          market({ status: "active", title: "Active market" }), // live → kept
        ]),
      ),
    );
    const rows = await searchVenue(cfg, "kalshi", "Kalshi", "btc", 20);
    expect(rows.map((r) => r.title)).toEqual([
      "Closed awaiting determination",
      "Temporarily inactive",
      "Active market",
    ]);
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
    t += 181_000; // past the 180s (3-min) TTL
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

  it("decomposes ACCENTED proper nouns (Mbappé, Jiménez, Müller) — the live empty-result bug", () => {
    // The old ASCII `[A-Z][\w…]` dropped accented names, so only the full phrase was searched (0 rows).
    expect(expandQueries("Mbappé goals")).toContain("Mbappé"); // the entity that actually has a market
    expect(expandQueries("Jiménez first goal")).toContain("Jiménez");
    expect(expandQueries("Müller Germany")).toEqual(expect.arrayContaining(["Müller", "Germany"]));
  });

  it("leaves a single-word query unchanged (it is already the entity)", () => {
    expect(expandQueries("Czechia")).toEqual(["Czechia"]);
    expect(expandQueries("bitcoin")).toEqual(["bitcoin"]);
  });

  it("does NOT decompose a capitalized month/weekday as an entity (the copper-for-bitcoin bug)", () => {
    // "June" passes PROPER_WORD but is a date, not an entity — decomposing it matched "…Fed in June",
    // "…copper above 6.14 on June". A month/weekday must never become a sub-query.
    expect(expandQueries("June 26 2026 cdt")).not.toContain("June");
    expect(expandQueries("bitcoin Friday")).not.toContain("Friday");
    // A real proper noun next to a month still decomposes (only the month token is excluded).
    expect(expandQueries("Argentina June")).toContain("Argentina");
    expect(expandQueries("Argentina June")).not.toContain("June");
    // LOWERCASE months/weekdays must also be excluded (the content-word path, not just proper-noun spans).
    expect(expandQueries("bitcoin june monday")).not.toEqual(expect.arrayContaining(["june", "monday"]));
    expect(expandQueries("bitcoin june monday")).toContain("bitcoin");
  });

  it("decomposes an all-lowercase compound into its content words (the '10 year treasury' recall bug)", () => {
    // pmxt substring-misses "10 year treasury" → "10-Year Treasury Yield"; the bare entity "treasury"
    // hits. Numbers + timeframe words are dropped; the salient noun is searched (relevance-floored vs the
    // original query, so generic content words that match nothing on-topic are dropped downstream).
    expect(expandQueries("10 year treasury")).toEqual(["10 year treasury", "treasury"]);
    // Numbers, timeframes ("15 minutes") AND framing words ("price") are dropped → just the entity.
    expect(expandQueries("bitcoin price 15 minutes")).toEqual(["bitcoin price 15 minutes", "bitcoin"]);
    // A plain two-word lowercase query also emits its words (only USED if the full phrase finds nothing).
    expect(expandQueries("world cup")).toEqual(["world cup", "world", "cup"]);
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

  it("RETRIES a transient (header-less) 429 — pmxt's free tier emits fast burst 429s that clear next call", async () => {
    let n = 0;
    stub(() => {
      n += 1;
      return n === 1 ? res({ error: "rate limited" }, 429) : res(resp([market()])); // 429 once, then OK
    });
    const rows = await searchVenue(cfg, "kalshi", "Kalshi", "x", 20);
    expect(n).toBe(2); // one retry cleared the transient 429
    expect(rows).toHaveLength(1);
  });

  it("gives up after exhausting the 429 retry budget (a PERSISTENT header-less 429 finally throws)", async () => {
    let n = 0;
    stub(() => {
      n += 1;
      return res({ error: "rate limited" }, 429);
    });
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "x", 20)).rejects.toBeInstanceOf(PmxtError);
    expect(n).toBe(3); // 1 initial attempt + MAX_RATE_RETRIES (2)
  });

  it("does NOT retry a definitive non-429 HTTP error (e.g. 500) — it is a real answer, not transient", async () => {
    let n = 0;
    stub(() => {
      n += 1;
      return res({ error: "boom" }, 500);
    });
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "x", 20)).rejects.toBeInstanceOf(PmxtError);
    expect(n).toBe(1); // no retry
  });
});

describe("client-side rate guard (the 429-storm fix)", () => {
  it("self-limits to 55 requests/min, fail-soft-drops the overflow (no network), then recovers when the window slides", async () => {
    let t = 0;
    __setHttpClock(() => t);
    stub(() => res(resp([market()])));
    for (let i = 0; i < 55; i++) await searchVenue(cfg, "kalshi", "Kalshi", `q${i}`, 20); // distinct → bypass cache
    expect(calls.length).toBe(55); // all 55 within the minute window reach the wire
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "q-over", 20)).rejects.toBeInstanceOf(PmxtRateLimitError);
    expect(calls.length).toBe(55); // the 56th is dropped BEFORE any network call
    t += 60_000; // the 60s window slides
    await searchVenue(cfg, "kalshi", "Kalshi", "q-after", 20);
    expect(calls.length).toBe(56); // calls flow again — no server cooldown was ever triggered
  });

  it("pauses every call after a server 429 (honoring Retry-After), short-circuiting until it elapses", async () => {
    let t = 0;
    __setHttpClock(() => t);
    let n = 0;
    stub(() => {
      n += 1;
      return res({ error: "rate limited" }, 429, { "retry-after": "30" });
    });
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "a", 20)).rejects.toBeInstanceOf(PmxtError); // real 429
    expect(n).toBe(1);
    // Inside the 30s Retry-After pause → fail-soft local error, NO network hit.
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "b", 20)).rejects.toBeInstanceOf(PmxtRateLimitError);
    expect(n).toBe(1); // unchanged — short-circuited before fetch
    t += 31_000; // past the Retry-After window
    await expect(searchVenue(cfg, "kalshi", "Kalshi", "c", 20)).rejects.toBeInstanceOf(PmxtError);
    expect(n).toBe(2); // pause lifted → it hit the wire again
  });

  it("does NOT pause on a 429 without Retry-After (transient blip → retried, and later calls still flow)", async () => {
    __setHttpClock(() => 0);
    let n = 0;
    stub(() => {
      n += 1;
      return n === 1 ? res({ error: "rate limited" }, 429) : res(resp([market()])); // 429 once, then OK forever
    });
    const rows = await searchVenue(cfg, "kalshi", "Kalshi", "a", 20); // header-less 429 → retried in place, succeeds
    expect(n).toBe(2);
    expect(rows).toHaveLength(1);
    // No pause was armed, so a later distinct query still reaches the wire (not short-circuited to a local cap).
    const more = await searchVenue(cfg, "kalshi", "Kalshi", "b", 20);
    expect(more).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("a 429 on one venue does not pre-empt a sibling call already in flight (fail-soft per slice)", async () => {
    __setHttpClock(() => 0);
    stub((url) =>
      url.includes("sourceExchange=kalshi")
        ? res({ error: "rate limited" }, 429)
        : res(resp([market({ sourceExchange: "polymarket", title: "Poly bitcoin market" })])),
    );
    const out = await searchExternal(cfg, "bitcoin", 20);
    expect(out.errored).toBe(true);
    expect(out.kalshi).toEqual([]); // persistent header-less 429 → retries exhausted → degraded to empty
    expect(out.polymarket).toHaveLength(1); // a header-less 429 never pauses siblings; this slice still succeeds
  });
});

describe("searchExternal staged fan-out (bounds the 429 risk)", () => {
  it("stops after the full query when it matches — no entity fan-out (2 calls, not 12)", async () => {
    stub((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      return res(resp(q === "FIFA World Cup" && url.includes("sourceExchange=kalshi") ? [market({ title: "World Cup Winner" })] : []));
    });
    const out = await searchExternal(cfg, "FIFA World Cup", 20);
    expect(out.errored).toBe(false);
    expect(out.kalshi).toHaveLength(1);
    expect(calls.length).toBe(2); // full query × 2 venues only — the decomposed fan-out never runs
  });

  it("surfaces an ACCENTED player's market via stage-2 decomposition (the Mbappé bug)", async () => {
    // Mirror live pmxt: the phrase "Mbappé goals" matches no title; the bare entity "Mbappé" does.
    stub((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      return res(resp(q === "Mbappé" && url.includes("sourceExchange=kalshi") ? [market({ title: "Kylian Mbappé: 2+ goals" })] : []));
    });
    const out = await searchExternal(cfg, "Mbappé goals", 20);
    expect(out.kalshi).toHaveLength(1); // reached only because "Mbappé" now decomposes out of the phrase
    expect(out.kalshi[0]!.title).toBe("Kylian Mbappé: 2+ goals");
  });

  it("falls back to entity sub-queries only when the full query is empty", async () => {
    stub((url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      return res(resp(q === "Raul Jimenez" && url.includes("sourceExchange=kalshi") ? [market({ title: "Raul Jimenez: 1+ goals" })] : []));
    });
    const out = await searchExternal(cfg, "Mexico Raul Jimenez player props", 20);
    expect(out.kalshi).toHaveLength(1); // reached only via the entity sub-query
    expect(calls.length).toBeGreaterThan(2); // stage 1 (2) + stage 2 entities
  });

  it("flags errored=true when a venue 429s (so the reply can say 'couldn't check')", async () => {
    stub((url) =>
      url.includes("sourceExchange=kalshi")
        ? res({ error: "rate limited" }, 429)
        : res(resp([market({ sourceExchange: "polymarket", title: "Poly bitcoin market" })])),
    );
    const out = await searchExternal(cfg, "bitcoin", 20);
    expect(out.errored).toBe(true);
    expect(out.polymarket).toHaveLength(1);
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
