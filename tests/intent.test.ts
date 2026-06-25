import { describe, it, expect, afterEach } from "vitest";
import { classify, classifyFollowup, parseIntent, refineClarify, __setClient } from "../src/sawa/intent";
import type { FollowupContext } from "../src/sawa/intent";
import type { IntentConfig } from "../src/sawa/config";
import type { ClarifyQuestion } from "../src/sawa/clarify";
import type { VenueResult } from "../src/venue";

const BOT = "sawa";
const cfg: IntentConfig = { apiKey: "k", model: "m", baseUrl: "https://x" };

/** Minimal OpenAI-shaped stub. `onCall` lets a test count invocations / throw. */
function stubClient(content: string | (() => never), onCall?: () => void) {
  return {
    chat: {
      completions: {
        create: async () => {
          onCall?.();
          if (typeof content === "function") content();
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as Parameters<typeof __setClient>[0];
}

/** Like `stubClient` but records the args each `create` call is invoked with (to assert params). */
function capturingStub(content: string) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as Parameters<typeof __setClient>[0];
  return { client, calls };
}

afterEach(() => __setClient(null));

describe("classify (regex-first gate)", () => {
  it("extracts the subject from explicit search triggers, stripping the address + filler + article", () => {
    expect(classify("sawa where can I bet on the FIFA World Cup", BOT)).toMatchObject({
      kind: "search",
      query: "FIFA World Cup",
      confident: true,
      via: "regex",
    });
    expect(classify("find world cup", BOT)).toMatchObject({ kind: "search", query: "world cup" });
    expect(classify("odds on bitcoin", BOT)).toMatchObject({ kind: "search", query: "bitcoin" });
    expect(classify("@sawa markets about the election", BOT)).toMatchObject({
      kind: "search",
      query: "election",
    });
  });

  it("treats greetings, create, account, and help as 'other'", () => {
    for (const msg of ["hey sawa", "hi", "thanks", "make a market on rain tomorrow", "my balance", "/help help"]) {
      expect(classify(msg, BOT).kind).toBe("other");
    }
  });

  it("treats an addressed bare topic as a (non-confident) search candidate", () => {
    const c = classify("sawa world cup", BOT);
    expect(c.kind).toBe("search");
    expect(c.query).toBe("world cup");
    expect(c.confident).toBe(false);
    expect(c.via).toBe("fallback");
  });

  it("resolves 'look for' / 'search for' / 'find me' phrasings at the regex gate (no LLM)", () => {
    expect(classify("look for Czechia Mexico", BOT)).toMatchObject({
      kind: "search",
      query: "Czechia Mexico",
      confident: true,
      via: "regex",
    });
    expect(classify("search for bitcoin", BOT)).toMatchObject({ kind: "search", query: "bitcoin", confident: true });
    expect(classify("find me the world cup", BOT)).toMatchObject({ kind: "search", query: "world cup", confident: true });
    expect(classify("sawa look for player props on Raul Jimenez", BOT)).toMatchObject({
      kind: "search",
      query: "player props on Raul Jimenez",
      confident: true,
      via: "regex",
    });
    // The bare verb "find" still works (longest-first alternation never swallows the subject).
    expect(classify("find world cup", BOT)).toMatchObject({ kind: "search", query: "world cup" });
  });

  it("peels a residual role phrase the first verb-trigger leaves behind (the bitcoin/oil bug)", () => {
    // "find me" strips only itself → "a market on bitcoin"; cleanQuery peels "a market on" → "bitcoin",
    // so the role-word "market" can no longer match an unrelated Sawa market ("…damage at the market").
    expect(classify("sawa find me a market on bitcoin", BOT)).toMatchObject({ kind: "search", query: "bitcoin" });
    expect(classify("find market on oil prices", BOT)).toMatchObject({ kind: "search", query: "oil prices" });
    expect(classify("sawa find me a market on the election", BOT)).toMatchObject({ kind: "search", query: "election" });
    expect(classify("get me a prediction for the super bowl", BOT)).toMatchObject({
      kind: "search",
      query: "super bowl",
    });
    // A legitimate "market" content word (no on/for/about/of right after it) is preserved untouched.
    expect(classify("sawa market cap of bitcoin", BOT)).toMatchObject({ kind: "search", query: "market cap of bitcoin" });
  });
});

describe("parseIntent", () => {
  it("returns the confident regex result WITHOUT calling the LLM", async () => {
    let called = 0;
    __setClient(stubClient('{"kind":"other"}', () => (called += 1)));
    const intent = await parseIntent("find world cup", BOT, cfg);
    expect(intent).toEqual({ kind: "search", query: "world cup", via: "regex" });
    expect(called).toBe(0);
  });

  it("consults the LLM when the gate is unsure, and uses its refined query", async () => {
    __setClient(stubClient('{"kind":"search","query":"Los Angeles mayor"}'));
    const intent = await parseIntent("sawa la mayor race thoughts", BOT, cfg);
    expect(intent).toEqual({ kind: "search", query: "Los Angeles mayor", via: "llm" });
  });

  it("falls back to the regex guess when the LLM errors", async () => {
    __setClient(
      stubClient(() => {
        throw new Error("503");
      }),
    );
    const intent = await parseIntent("sawa some ambiguous thing", BOT, cfg);
    expect(intent.via).toBe("fallback");
    expect(intent.kind).toBe("search");
    expect(intent.query).toBe("some ambiguous thing");
  });

  it("skips the LLM entirely when no intent config is provided", async () => {
    const intent = await parseIntent("sawa bare topic here", BOT, null);
    expect(intent.kind).toBe("search");
    expect(intent.query).toBe("bare topic here");
    expect(intent.via).toBe("fallback");
  });

  it("honors an LLM 'other' classification", async () => {
    __setClient(stubClient('{"kind":"other","query":""}'));
    const intent = await parseIntent("sawa hmm what do you think", BOT, cfg);
    expect(intent.kind).toBe("other");
    expect(intent.via).toBe("llm");
  });
});

const activeCtx: FollowupContext = {
  hasActiveMarket: true,
  query: "world cup",
  currentVenue: "sawa",
  venuesPresent: ["sawa", "kalshi"],
};
const coldCtx: FollowupContext = { hasActiveMarket: false, venuesPresent: [] };

describe("classifyFollowup", () => {
  it("returns null without an active market (a cold 'next'/'link' is never a follow-up)", () => {
    expect(classifyFollowup("not that", BOT, coldCtx)).toBeNull();
    expect(classifyFollowup("kalshi link", BOT, coldCtx)).toBeNull();
  });

  it("classifies rejection phrases as 'next'", () => {
    for (const m of ["not that", "nah", "different one", "another", "next", "more", "wrong one", "show me another"]) {
      expect(classifyFollowup(m, BOT, activeCtx)).toMatchObject({ kind: "next", confident: true });
    }
  });

  it("classifies link requests and extracts the venue", () => {
    expect(classifyFollowup("send the kalshi link", BOT, activeCtx)).toMatchObject({ kind: "link", venue: "kalshi" });
    expect(classifyFollowup("got a polymarket one?", BOT, activeCtx)).toMatchObject({ kind: "link", venue: "polymarket" });
    expect(classifyFollowup("poly?", BOT, activeCtx)).toMatchObject({ kind: "link", venue: "polymarket" });
    expect(classifyFollowup("kalshi", BOT, activeCtx)).toMatchObject({ kind: "link", venue: "kalshi" });
    const generic = classifyFollowup("link", BOT, activeCtx);
    expect(generic).toMatchObject({ kind: "link" });
    expect(generic!.venue).toBeUndefined();
  });

  it("returns null for an ambiguous / new-topic message (defers to the gate or context LLM)", () => {
    expect(classifyFollowup("what about the nba finals", BOT, activeCtx)).toBeNull();
  });

  it("does NOT treat a rejection-prefixed real request as 'next' (precision over recall)", () => {
    for (const m of ["no idea what that is", "more info please", "show me more about it", "next election"]) {
      expect(classifyFollowup(m, BOT, activeCtx)).toBeNull();
    }
  });

  it("still matches a rejection that ends in a benign filler", () => {
    for (const m of ["not that one", "another one", "next market", "more please"]) {
      expect(classifyFollowup(m, BOT, activeCtx)).toMatchObject({ kind: "next" });
    }
  });
});

describe("parseIntent with active-market context", () => {
  it("prefers a regex follow-up over a new search, without calling the LLM", async () => {
    let called = 0;
    __setClient(stubClient('{"kind":"search","query":"kalshi"}', () => (called += 1)));
    const intent = await parseIntent("not that", BOT, cfg, activeCtx);
    expect(intent).toEqual({ kind: "next", via: "regex" });
    expect(called).toBe(0);
  });

  it("routes a bare venue word to a link follow-up (no LLM needed)", async () => {
    const intent = await parseIntent("kalshi", BOT, null, activeCtx);
    expect(intent).toMatchObject({ kind: "link", venue: "kalshi", via: "regex" });
  });

  it("uses the context LLM to disambiguate an ambiguous follow-up as a link", async () => {
    __setClient(stubClient('{"kind":"link","venue":"kalshi","query":""}'));
    const intent = await parseIntent("what about kalshi", BOT, cfg, activeCtx);
    expect(intent).toEqual({ kind: "link", venue: "kalshi", via: "llm" });
  });

  it("still treats a confident new-search trigger as a search mid-thread", async () => {
    const intent = await parseIntent("find nba finals", BOT, cfg, activeCtx);
    expect(intent).toMatchObject({ kind: "search", query: "nba finals", via: "regex" });
  });
});

describe("classifyWithLlm JSON robustness (Issue 1)", () => {
  it("requests max_tokens 256 (was 80 — the truncation cause)", async () => {
    const { client, calls } = capturingStub('{"kind":"search","query":"bitcoin"}');
    __setClient(client);
    await parseIntent("sawa hmm thoughts on btc", BOT, cfg);
    expect(calls[0]!.max_tokens).toBe(256);
  });

  it("parses multi-line / pretty-printed JSON (the live failure shape)", async () => {
    __setClient(stubClient('{\n  "kind": "search",\n  "query": "World Cup"\n}'));
    const intent = await parseIntent("sawa thoughts on the cup", BOT, cfg);
    expect(intent).toMatchObject({ kind: "search", query: "World Cup", via: "llm" });
  });

  it("parses a ```json fenced body", async () => {
    __setClient(stubClient('```json\n{"kind":"search","query":"Bitcoin"}\n```'));
    const intent = await parseIntent("sawa thoughts on btc", BOT, cfg);
    expect(intent).toMatchObject({ kind: "search", query: "Bitcoin", via: "llm" });
  });

  it("parses a body with leading prose around the object", async () => {
    __setClient(stubClient('Sure! Here you go: {"kind":"other","query":""} hope that helps'));
    const intent = await parseIntent("sawa what do you reckon", BOT, cfg);
    expect(intent).toMatchObject({ kind: "other", via: "llm" });
  });

  it("unwraps an array-wrapped object (gemini returns [ {…} ] despite json_object mode)", async () => {
    __setClient(stubClient('[{"kind":"search","query":"Argentina"}]'));
    const intent = await parseIntent("sawa thoughts on argentina", BOT, cfg);
    expect(intent).toMatchObject({ kind: "search", query: "Argentina", via: "llm" });
  });

  it("unwraps a multi-line array (the live failure: body started with '[')", async () => {
    __setClient(stubClient('[\n  {"kind": "search", "query": "World Cup"},\n  {"kind": "other"}\n]'));
    const intent = await parseIntent("sawa hmm the cup", BOT, cfg);
    expect(intent).toMatchObject({ kind: "search", query: "World Cup", via: "llm" });
  });

  it("falls back to the regex gate (never throws) on a truncated/unparseable body", async () => {
    __setClient(stubClient('{"kind":"search","query":"World C')); // cut off mid-string
    const intent = await parseIntent("sawa some ambiguous thing", BOT, cfg);
    expect(intent.via).toBe("fallback");
    expect(intent).toMatchObject({ kind: "search", query: "some ambiguous thing" });
  });
});

describe("refineClarify (LLM relabel / veto, fail-soft)", () => {
  const row = (title: string): VenueResult => ({
    venue: "kalshi", sourceLabel: "Kalshi", realMoney: true, title, url: "https://k/x",
    top: { label: "Yes", price: 0.5 }, relevance: 1,
  });
  const question: ClarifyQuestion = {
    question: 'Which "world cup" market did you mean?',
    options: [
      { label: "Will Brazil win the World Cup?", result: row("Will Brazil win the World Cup?") },
      { label: "Will France win the World Cup?", result: row("Will France win the World Cup?") },
    ],
  };

  it("VETOES when the model says these are one market's outcomes (→ answer directly)", async () => {
    __setClient(stubClient('{"ambiguous":false}'));
    expect(await refineClarify("world cup", question, cfg)).toBeNull();
  });

  it("relabels the options in order when the model confirms ambiguity", async () => {
    __setClient(stubClient('{"ambiguous":true,"labels":["Brazil to win","France to win"]}'));
    const out = await refineClarify("world cup", question, cfg);
    expect(out!.options.map((o) => o.label)).toEqual(["Brazil to win", "France to win"]);
    expect(out!.options[0]!.result.title).toBe("Will Brazil win the World Cup?"); // result mapping preserved
  });

  it("keeps the deterministic question on a label-count mismatch", async () => {
    __setClient(stubClient('{"ambiguous":true,"labels":["only one"]}'));
    const out = await refineClarify("world cup", question, cfg);
    expect(out!.options.map((o) => o.label)).toEqual(question.options.map((o) => o.label));
  });

  it("is fail-soft: an unparseable body keeps the deterministic question (we still ask)", async () => {
    __setClient(stubClient("not json at all"));
    expect(await refineClarify("world cup", question, cfg)).toBe(question);
  });

  it("is fail-soft: a thrown LLM error keeps the deterministic question", async () => {
    __setClient(stubClient(() => {
      throw new Error("network down");
    }));
    expect(await refineClarify("world cup", question, cfg)).toBe(question);
  });
});
