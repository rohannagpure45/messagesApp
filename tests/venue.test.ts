import { describe, it, expect } from "vitest";
import { scoreRelevance, tokenize } from "../src/venue";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens", () => {
    expect(tokenize("Who will win the World Cup?")).toEqual(["win", "world", "cup"]);
    expect(tokenize("2026 US election")).toEqual(["2026", "us", "election"]);
  });
});

describe("scoreRelevance (token-boundary, not substring)", () => {
  it("scores share of query tokens present as whole title tokens", () => {
    expect(scoreRelevance("Who will win the World Cup?", "FIFA World Cup")).toBeCloseTo(2 / 3, 5);
    expect(scoreRelevance("World Cup Final winner", "world cup")).toBe(1);
  });

  it("does NOT let the short token 'us' match inside 'business' (the bug we fixed)", () => {
    // "2026 US election" must NOT match an unrelated "NVC Business Track Competition".
    expect(scoreRelevance("Who will win the NVC Business Track Competition", "2026 US election")).toBe(0);
  });

  it("matches inflections/plurals only for longer tokens via shared prefix", () => {
    expect(scoreRelevance("US elections 2026 results", "election")).toBe(1); // election ~ elections
    expect(scoreRelevance("bitcoins to the moon", "bitcoin")).toBe(1);
    expect(scoreRelevance("Los Angeles Mayoral race", "mayor")).toBe(1); // mayor ~ mayoral
  });

  it("returns 0 for an empty query", () => {
    expect(scoreRelevance("anything", "")).toBe(0);
  });

  it("drops domain role-words from the QUERY so framing words can't carry a false hit", () => {
    // The live-test failure: "market on bitcoin" matched a Sawa market titled "…at the market".
    expect(scoreRelevance("Who will do the most damage at the market? Lily/Dana", "market on bitcoin")).toBe(0);
    // Role-words ignored on the query side: only "bitcoin" counts, and it IS in the title.
    expect(scoreRelevance("Bitcoin price end of year", "market on bitcoin")).toBe(1);
    // A query of ONLY role-words has no topic to match → 0.
    expect(scoreRelevance("Bitcoin price end of year", "market odds")).toBe(0);
    // But a legitimate title token "market" still tokenizes on the TITLE side (query has real content).
    expect(scoreRelevance("US stock market crash 2026", "stock market")).toBe(1);
  });

  it("scores a query made entirely of role-words as 0 (accepted meta-query constraint)", () => {
    expect(scoreRelevance("Prediction Market Mechanics Explained", "prediction market")).toBe(0);
    // "betting" is NOT a role-word, so "betting odds" keeps a real token and still matches.
    expect(scoreRelevance("Understanding Betting Strategy", "betting odds")).toBe(1);
  });
});
