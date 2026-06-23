import { describe, it, expect, afterEach } from "vitest";
import { classify, parseIntent, __setClient } from "../src/sawa/intent";
import type { IntentConfig } from "../src/sawa/config";

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
