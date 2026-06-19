import { describe, it, expect } from "vitest";
import { formatList, formatMarket } from "../src/sawa/format";
import type { Market } from "../src/sawa/types";

const market = (over: Partial<Market> = {}): Market => ({
  venue: "sawa",
  ref: "sawa:abc",
  id: "abc",
  title: "Will it rain tomorrow?",
  resolved: false,
  outcomes: [
    { label: "Yes", oddsPct: 62 },
    { label: "No", oddsPct: 38 },
  ],
  ...over,
});

describe("formatMarket", () => {
  it("renders title, rounded odds, and deadline date", () => {
    const out = formatMarket(market({ deadline: "2026-07-01T12:00:00" }));
    expect(out).toContain("Will it rain tomorrow?");
    expect(out).toContain("Yes 62%");
    expect(out).toContain("No 38%");
    expect(out).toContain("2026-07-01");
  });

  it("shows an em-dash for missing odds", () => {
    const out = formatMarket(market({ outcomes: [{ label: "Yes", oddsPct: null }] }));
    expect(out).toContain("Yes —");
  });

  it("handles a market with no options", () => {
    expect(formatMarket(market({ outcomes: [] }))).toContain("(no odds yet)");
  });
});

describe("formatList", () => {
  it("messages the empty state with disclaimer", () => {
    const out = formatList([]);
    expect(out).toContain("No open markets");
    expect(out.toLowerCase()).toContain("no cash value");
  });

  it("numbers markets and includes the disclaimer", () => {
    const out = formatList([market(), market({ id: "d2", title: "Second" })]);
    expect(out).toContain("1. Will it rain tomorrow?");
    expect(out).toContain("2. Second");
    expect(out.toLowerCase()).toContain("no cash value");
  });
});
