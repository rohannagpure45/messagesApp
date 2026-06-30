import { describe, it, expect } from "vitest";
import { clusterTopics, decideClarify, resolveAnswer, renderClarifyText } from "../src/sawa/clarify";
import type { ClarifyQuestion } from "../src/sawa/clarify";
import type { VenueResult } from "../src/venue";

const row = (over: Partial<VenueResult> & { title: string }): VenueResult => ({
  venue: "kalshi",
  sourceLabel: "Kalshi",
  realMoney: true,
  url: "https://kalshi.com/e/x",
  top: { label: "Yes", price: 0.5 },
  relevance: 1,
  ...over,
});

// Per-team slices of ONE event — near-identical titles, so they collapse to a single topic.
const worldCupSlices = [
  row({ title: "World Cup Winner - Will Brazil win?" }),
  row({ title: "World Cup Winner - Will France win?" }),
  row({ title: "World Cup Winner - Will Argentina win?" }),
];
// Genuinely DIFFERENT bitcoin markets — distinct questions a user must choose between.
const bitcoinMarkets = [
  row({ title: "Bitcoin price on Dec 31 2026", venue: "kalshi", sourceLabel: "Kalshi" }),
  row({ title: "Bitcoin to reach $200k this year", venue: "polymarket", sourceLabel: "Polymarket" }),
  row({ title: "Bitcoin dominance above 60%", venue: "sawa", sourceLabel: "Sawa", realMoney: false }),
];

describe("clusterTopics", () => {
  it("collapses per-outcome slices of one event into a single topic (the favorite leads)", () => {
    expect(clusterTopics(worldCupSlices)).toHaveLength(1);
  });

  it("keeps genuinely distinct topics separate", () => {
    expect(clusterTopics(bitcoinMarkets)).toHaveLength(3);
  });

  it("dedupes the same market listed across two venues", () => {
    const same = [
      row({ title: "Bitcoin above $150k", venue: "kalshi", sourceLabel: "Kalshi" }),
      row({ title: "Bitcoin above $150k", venue: "polymarket", sourceLabel: "Polymarket" }),
    ];
    expect(clusterTopics(same)).toHaveLength(1);
  });

  it("clusters as the same topic at exactly the 0.5 similarity boundary (>=)", () => {
    // {cup,winner,schedule} vs {world,cup,winner}: intersect=2, union=4 → Jaccard 0.5 → same topic.
    const pair = [row({ title: "Cup Winner Schedule" }), row({ title: "World Cup Winner" })];
    expect(clusterTopics(pair)).toHaveLength(1);
  });
});

describe("decideClarify", () => {
  it("returns null for fewer than two candidates (a clear single answer)", () => {
    expect(decideClarify([row({ title: "Bitcoin price" })], "bitcoin")).toBeNull();
    expect(decideClarify([], "bitcoin")).toBeNull();
  });

  it("does NOT ask when the matches are one event's outcomes (clusters to a single topic)", () => {
    expect(decideClarify(worldCupSlices, "world cup")).toBeNull();
  });

  it("asks when ≥2 strong, distinct topics match, with one option each", () => {
    const q = decideClarify(bitcoinMarkets, "bitcoin");
    expect(q).not.toBeNull();
    expect(q!.options).toHaveLength(3);
    expect(q!.question.toLowerCase()).toContain("bitcoin");
    expect(q!.options.map((o) => o.result.title)).toEqual([
      "Bitcoin price on Dec 31 2026",
      "Bitcoin to reach $200k this year",
      "Bitcoin dominance above 60%",
    ]);
  });

  it("caps the options at four even when more distinct topics match", () => {
    const five = [
      row({ title: "Election: who wins the presidency" }),
      row({ title: "Senate control after midterms" }),
      row({ title: "Governor race in California" }),
      row({ title: "Turnout above 60 percent" }),
      row({ title: "Recount triggered in Georgia" }),
    ];
    const q = decideClarify(five, "election");
    expect(q!.options).toHaveLength(4);
  });

  it("ignores topics below the strong-relevance bar (need ≥2 STRONG)", () => {
    const cands = [
      row({ title: "Bitcoin price target", relevance: 1 }),
      row({ title: "Ethereum merge upgrade", relevance: 0.4 }), // distinct topic but too weak to offer
    ];
    expect(decideClarify(cands, "crypto")).toBeNull();
  });
});

describe("resolveAnswer", () => {
  const q: ClarifyQuestion = {
    question: 'Which "bitcoin" market did you mean?',
    options: [
      { label: "Bitcoin price Dec 31", result: row({ title: "Bitcoin price on Dec 31 2026", venue: "kalshi", sourceLabel: "Kalshi" }) },
      { label: "Reach $200k", result: row({ title: "Bitcoin to reach $200k", venue: "polymarket", sourceLabel: "Polymarket" }) },
      { label: "Dominance 60%", result: row({ title: "Bitcoin dominance above 60%", venue: "sawa", sourceLabel: "Sawa", realMoney: false }) },
    ],
  };

  it("matches the exact option label (a native poll tap returns it verbatim)", () => {
    expect(resolveAnswer(q, "Reach $200k")?.result.title).toBe("Bitcoin to reach $200k");
    expect(resolveAnswer(q, "dominance 60%")?.label).toBe("Dominance 60%"); // case-insensitive
  });

  it("matches a 1-based number, and rejects out-of-range numbers", () => {
    expect(resolveAnswer(q, "2")?.label).toBe("Reach $200k");
    expect(resolveAnswer(q, "#3")?.label).toBe("Dominance 60%");
    expect(resolveAnswer(q, "9")).toBeNull();
  });

  it("matches ordinal words including 'last'", () => {
    expect(resolveAnswer(q, "the first one")?.label).toBe("Bitcoin price Dec 31");
    expect(resolveAnswer(q, "second")?.label).toBe("Reach $200k");
    expect(resolveAnswer(q, "the last one please")?.label).toBe("Dominance 60%");
  });

  it("matches a venue word only when exactly one option is on that venue", () => {
    expect(resolveAnswer(q, "the kalshi one")?.label).toBe("Bitcoin price Dec 31");
    expect(resolveAnswer(q, "send me the sawa market")?.label).toBe("Dominance 60%");
  });

  it("matches a distinctive substring, but stays null when it's ambiguous or absent", () => {
    expect(resolveAnswer(q, "dominance")?.label).toBe("Dominance 60%");
    expect(resolveAnswer(q, "bitcoin")).toBeNull(); // in every title → ambiguous → don't guess
    expect(resolveAnswer(q, "ethereum")).toBeNull(); // not an answer at all → fall through to a new search
    expect(resolveAnswer(q, "")).toBeNull();
  });

  it("rejects out-of-range / non-positive numbers and pure-filler answers (no false resolution)", () => {
    expect(resolveAnswer(q, "0")).toBeNull(); // 1-based → index -1 → out of range
    expect(resolveAnswer(q, "-1")).toBeNull();
    expect(resolveAnswer(q, "the one please")).toBeNull(); // strips to empty → no substring match
  });
});

describe("renderClarifyText", () => {
  it("renders a numbered list with a reply hint (the local/terminal fallback)", () => {
    const q: ClarifyQuestion = {
      question: 'Which "bitcoin" market did you mean?',
      options: [
        { label: "Price Dec 31", result: row({ title: "a" }) },
        { label: "Reach $200k", result: row({ title: "b" }) },
      ],
    };
    const txt = renderClarifyText(q);
    expect(txt).toContain('Which "bitcoin" market did you mean?');
    expect(txt).toContain("1. Price Dec 31");
    expect(txt).toContain("2. Reach $200k");
    expect(txt).toContain("Reply with a number");
  });
});
