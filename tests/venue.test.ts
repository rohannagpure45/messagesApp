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
  });

  it("returns 0 for an empty query", () => {
    expect(scoreRelevance("anything", "")).toBe(0);
  });
});
