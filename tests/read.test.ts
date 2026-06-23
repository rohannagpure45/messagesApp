import { describe, it, expect, afterEach } from "vitest";
import { listMarkets, getMarket, getTrending } from "../src/sawa/read";
import type { Config } from "../src/sawa/config";

// Behavioral coverage for the discovery read path. read.ts calls `globalThis.fetch` via the
// getJson helper, so we stub fetch with payloads shaped exactly like the SHIPPED Sawa-app routes
// (GET /api/predictions, /[id], /[id]/odds, /trending) and assert the parsing, parimutuel odds
// math, open/public filtering, paging, and error→null mapping.

const cfg: Config = { apiBaseUrl: "https://sawa.test", marketUrlTemplate: "https://sawa.test/market/{id}" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    json: async () => body,
  } as unknown as Response;
}

/** Install a fetch stub that routes by URL string. */
function stub(handler: (url: string) => Response): void {
  globalThis.fetch = ((url: string | URL) => Promise.resolve(handler(String(url)))) as typeof fetch;
}

/** A `GET /api/predictions` / `/trending` feed row (per-option pool at bets[0].amount, total at volume). */
function feedRow(
  id: string,
  title: string,
  pools: Record<string, number>,
  extra: Partial<{ resolved: boolean; isPrivate: boolean; category: string }> = {},
) {
  const volume = Object.values(pools).reduce((s, n) => s + n, 0);
  return {
    id,
    title,
    category: extra.category ?? "other",
    deadline: "2026-07-01T00:00:00Z",
    resolved: extra.resolved ?? false,
    isPrivate: extra.isPrivate ?? false,
    volume,
    options: Object.entries(pools).map(([label, amount], i) => ({ id: `${id}o${i}`, label, bets: [{ amount }] })),
  };
}

function feedPage(rows: unknown[], page = 1, pages = 1) {
  return { predictions: rows, pagination: { page, limit: 100, total: rows.length, pages } };
}

describe("listMarkets", () => {
  it("computes parimutuel display odds from each option's pool share and drops resolved + private", async () => {
    stub(() =>
      res(
        feedPage([
          feedRow("m1", "Will it rain in NYC?", { Yes: 210, No: 90 }),
          feedRow("m2", "Resolved match", { A: 50 }, { resolved: true }),
          feedRow("m3", "Private one", { X: 0 }, { isPrivate: true }),
        ]),
      ),
    );
    const markets = await listMarkets(cfg, { limit: 10 });
    expect(markets.map((m) => m.id)).toEqual(["m1"]); // m2 (resolved) + m3 (private) excluded
    const m1 = markets[0];
    expect(m1.outcomes).toEqual([
      { label: "Yes", oddsPct: 70 },
      { label: "No", oddsPct: 30 },
    ]);
    expect(m1.url).toBe("https://sawa.test/market/m1");
  });

  it("renders an empty pool as null odds (no division by zero)", async () => {
    stub(() => res(feedPage([feedRow("m4", "World Cup winner?", { France: 0, Brazil: 0 })])));
    const [m] = await listMarkets(cfg);
    expect(m.outcomes.every((o) => o.oddsPct === null)).toBe(true);
  });

  it("filters by client-side title search (case-insensitive)", async () => {
    stub(() =>
      res(
        feedPage([
          feedRow("m1", "Will it rain in NYC?", { Yes: 1 }),
          feedRow("m4", "World Cup winner?", { France: 1 }),
        ]),
      ),
    );
    const markets = await listMarkets(cfg, { search: "world cup" });
    expect(markets.map((m) => m.id)).toEqual(["m4"]);
  });

  it("pages past a resolved-heavy first page to fill the requested limit (no under-fill)", async () => {
    // Page 1 is entirely resolved; the open markets live on page 2. Paging must keep going.
    const page1 = feedPage([feedRow("r1", "old", { A: 1 }, { resolved: true })], 1, 2);
    const page2 = feedPage([feedRow("o1", "open one", { Yes: 1 }), feedRow("o2", "open two", { Yes: 1 })], 2, 2);
    stub((url) => res(/[?&]page=2(&|$)/.test(url) ? page2 : page1));
    const markets = await listMarkets(cfg, { limit: 2 });
    expect(markets.map((m) => m.id)).toEqual(["o1", "o2"]);
  });

  it("stops early once `limit` open markets are collected", async () => {
    let pagesFetched = 0;
    stub((url) => {
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      pagesFetched = Math.max(pagesFetched, page);
      return res(feedPage([feedRow(`a${page}`, "open", { Yes: 1 }), feedRow(`b${page}`, "open", { Yes: 1 })], page, 3));
    });
    const markets = await listMarkets(cfg, { limit: 2 });
    expect(markets.length).toBe(2);
    expect(pagesFetched).toBe(1); // filled from page 1; never fetched page 2
  });
});

describe("getMarket", () => {
  const detail = {
    prediction: {
      id: "m1",
      title: "Will it rain in NYC?",
      category: "weather",
      deadline: "2026-07-01T00:00:00Z",
      resolved: false,
      isPrivate: false,
      isHidden: false,
      options: [
        { id: "o1", label: "Yes" },
        { id: "o2", label: "No" },
      ],
    },
  };
  const odds = { odds: [{ id: "o1", total: 210 }, { id: "o2", total: 90 }], totalPool: 300, resolved: false };

  it("merges detail labels with the dedicated /odds pool sums", async () => {
    stub((url) => res(url.includes("/odds") ? odds : detail));
    const m = await getMarket(cfg, "m1");
    expect(m?.id).toBe("m1");
    expect(m?.outcomes).toEqual([
      { label: "Yes", oddsPct: 70 },
      { label: "No", oddsPct: 30 },
    ]);
  });

  it("maps a private (401) / forbidden (403) / missing (404) detail to null", async () => {
    for (const status of [401, 403, 404]) {
      stub(() => res({ error: "x" }, status));
      expect(await getMarket(cfg, "priv")).toBeNull();
    }
  });

  it("rethrows on an unexpected upstream 500 (so the router surfaces 'unreachable')", async () => {
    stub(() => res({ error: "boom" }, 500));
    await expect(getMarket(cfg, "m1")).rejects.toThrow();
  });

  it("fail-softs odds to null when the /odds call errors, still returning the market", async () => {
    stub((url) => (url.includes("/odds") ? res({ error: "boom" }, 500) : res(detail)));
    const m = await getMarket(cfg, "m1");
    expect(m?.id).toBe("m1");
    expect(m?.outcomes.every((o) => o.oddsPct === null)).toBe(true);
  });
});

describe("getTrending", () => {
  it("returns public open markets and filters resolved + private", async () => {
    stub(() =>
      res({
        predictions: [
          feedRow("t1", "hot one", { Yes: 60, No: 40 }),
          feedRow("t2", "done", { A: 10 }, { resolved: true }),
          feedRow("t3", "secret", { X: 5 }, { isPrivate: true }),
        ],
      }),
    );
    const markets = await getTrending(cfg, 5);
    expect(markets.map((m) => m.id)).toEqual(["t1"]);
    expect(markets[0].outcomes).toEqual([
      { label: "Yes", oddsPct: 60 },
      { label: "No", oddsPct: 40 },
    ]);
  });
});
