import { describe, it, expect } from "vitest";
import {
  formatPrice,
  searchLead,
  searchBody,
  topSawaRichlinkUrl,
  emptyReply,
  renderSearch,
} from "../src/sawa/cards";
import type { SearchResults } from "../src/search";
import type { VenueResult } from "../src/venue";

const sawa = (over: Partial<VenueResult> = {}): VenueResult => ({
  venue: "sawa",
  sourceLabel: "Sawa",
  realMoney: false,
  title: "Who will win the World Cup?",
  url: "https://sawapredictions.com/predictions/abc",
  top: { label: "Brazil", oddsPct: 59 },
  relevance: 0.8,
  ...over,
});
const ext = (over: Partial<VenueResult> = {}): VenueResult => ({
  venue: "kalshi",
  sourceLabel: "Kalshi",
  realMoney: true,
  title: "Who will win Los Angeles Mayoral Election?",
  url: "https://kalshi.com/events/x",
  top: { label: "Karen Bass", price: 0.65 },
  relevance: 0.7,
  ...over,
});
const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  query: "world cup",
  sawa: [],
  kalshi: [],
  polymarket: [],
  empty: false,
  truncated: false,
  externalUnavailable: false,
  ...over,
});

describe("formatPrice", () => {
  it("renders cents + implied return multiple", () => {
    expect(formatPrice(0.65)).toEqual({ text: "65¢", multiple: 1.5 });
    expect(formatPrice(0.08)).toEqual({ text: "8¢", multiple: 12.5 });
  });
  it("renders sub-cent and dead prices without a misleading multiple", () => {
    expect(formatPrice(0.003)).toEqual({ text: "<1¢" });
    expect(formatPrice(0)).toEqual({ text: "—" });
  });
});

describe("searchBody", () => {
  it("renders one compact line per market, price-first, with a tappable link", () => {
    const body = searchBody(results({ sawa: [sawa()], kalshi: [ext()] }));
    expect(body).toContain("🪙 **Sawa** · Who will win the World Cup? · Brazil 59%");
    expect(body).toContain("[open](https://sawapredictions.com/predictions/abc)");
    expect(body).toContain("📈 **Kalshi** · Who will win Los Angeles Mayoral Election? · Karen Bass 65¢ (1.5×)");
    expect(body).toContain("[open](https://kalshi.com/events/x)");
  });

  it("distinguishes virtual coins from real-money venues and always carries the disclaimer", () => {
    const body = searchBody(results({ sawa: [sawa()], polymarket: [ext({ sourceLabel: "Polymarket", venue: "polymarket" })] }));
    expect(body).toContain("🪙 Sawa = virtual coins");
    expect(body).toContain("📈 Kalshi/Polymarket = real money");
    expect(body.toLowerCase()).toContain("no cash value");
  });

  it("shows 'no pool yet' for a Sawa market with an empty pool (brand-safe, no 'odds' wording)", () => {
    const body = searchBody(results({ sawa: [sawa({ top: { label: "Yes", oddsPct: null } })] }));
    expect(body).toContain("Yes · no pool yet");
    expect(body).not.toMatch(/\bodds\b/i);
  });

  it("adds a 'narrow your search' note only when truncated", () => {
    expect(searchBody(results({ sawa: [sawa()], truncated: true }))).toContain("narrow your search");
    expect(searchBody(results({ sawa: [sawa()], truncated: false }))).not.toContain("narrow your search");
  });

  it("orders Sawa first, then Kalshi, then Polymarket", () => {
    const body = searchBody(
      results({
        sawa: [sawa()],
        kalshi: [ext()],
        polymarket: [ext({ sourceLabel: "Polymarket", venue: "polymarket", title: "Poly market" })],
      }),
    );
    expect(body.indexOf("Sawa")).toBeLessThan(body.indexOf("Kalshi"));
    expect(body.indexOf("Kalshi")).toBeLessThan(body.indexOf("Polymarket"));
  });
});

describe("topSawaRichlinkUrl", () => {
  it("returns the first Sawa market with a URL (public-only by construction)", () => {
    expect(topSawaRichlinkUrl(results({ sawa: [sawa({ url: undefined }), sawa({ url: "https://s/p/2" })] }))).toBe(
      "https://s/p/2",
    );
    expect(topSawaRichlinkUrl(results({ kalshi: [ext()] }))).toBeUndefined();
  });
});

describe("renderSearch", () => {
  it("renders the empty state with a create tease + disclaimer when nothing matched", () => {
    const r = renderSearch(results({ empty: true, query: "nonexistent" }));
    expect(r.empty).toBe(true);
    expect(r.lead).toContain("nonexistent");
    expect(r.lead.toLowerCase()).toContain("coming soon");
    expect(r.body).toBe("");
  });

  it("renders lead + body + richlink for a non-empty result", () => {
    const r = renderSearch(results({ sawa: [sawa()], kalshi: [ext()] }));
    expect(r.empty).toBe(false);
    expect(r.lead).toContain('"world cup"');
    expect(r.body).toContain("**Sawa**");
    expect(r.richlinkUrl).toBe("https://sawapredictions.com/predictions/abc");
  });
});

describe("emptyReply", () => {
  it("names the query and teases create", () => {
    const out = emptyReply("dogecoin");
    expect(out).toContain("dogecoin");
    expect(out.toLowerCase()).toContain("no cash value");
  });
});
