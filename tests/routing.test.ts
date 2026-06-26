import { describe, it, expect } from "vitest";
import {
  mentionsBot,
  shouldHandle,
  SeenSet,
  normalizeHandle,
  actionableWhenRelaxed,
  threadOwner,
  sessionKey,
  canRelaxSender,
} from "../src/routing";
import type { Intent } from "../src/sawa/intent";

describe("mentionsBot", () => {
  it("matches when the bot is hailed at the start or via @mention", () => {
    expect(mentionsBot("sawa find world cup", "sawa")).toBe(true);
    expect(mentionsBot("@sawa odds on bitcoin", "sawa")).toBe(true);
    expect(mentionsBot("hey sawa what's up", "sawa")).toBe(true);
    expect(mentionsBot("SAWA help", "sawa")).toBe(true);
    expect(mentionsBot("ask @sawa about it", "sawa")).toBe(true);
  });

  it("does not match bystander chatter that merely names the bot mid-sentence", () => {
    expect(mentionsBot("I told my friend about sawa yesterday", "sawa")).toBe(false);
    expect(mentionsBot("where is the nearest cafe", "sawa")).toBe(false);
  });
});

describe("normalizeHandle", () => {
  it("reduces phone formats to digits with a preserved leading +", () => {
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeHandle("(555) 123-4567")).toBe("5551234567");
    expect(normalizeHandle("  +1-555-123-4567 ")).toBe("+15551234567");
  });
  it("lowercases email-style Apple IDs so case drift doesn't fork identity", () => {
    expect(normalizeHandle("User@iCloud.com")).toBe("user@icloud.com");
  });
  it("passes through non-phone, non-email tokens", () => {
    expect(normalizeHandle("unknown")).toBe("unknown");
    expect(normalizeHandle("")).toBe("");
  });
});

describe("shouldHandle", () => {
  it("always handles slash commands and DMs; gates group chatter on a mention", () => {
    expect(shouldHandle({ isGroup: true, isSlash: true, body: "/search x", botName: "sawa" })).toBe(true);
    expect(shouldHandle({ isGroup: false, isSlash: false, body: "world cup", botName: "sawa" })).toBe(true); // DM
    expect(shouldHandle({ isGroup: true, isSlash: false, body: "sawa world cup", botName: "sawa" })).toBe(true);
    expect(shouldHandle({ isGroup: true, isSlash: false, body: "lol nice game", botName: "sawa" })).toBe(false);
  });
});

describe("thread ownership (the DM handle-flapping fix)", () => {
  const SPACE = "space-1";

  it("binds a DM to the SPACE, so the same thread survives the sender handle flapping to 'unknown'", () => {
    // The live bug: in LOCAL mode chat.db's handle join intermittently yields "" → "unknown" for the
    // SAME DM sender, which forked the session and dropped the clarify answer. A DM owner is the space.
    const known = threadOwner(SPACE, "+16302101333", false);
    const flapped = threadOwner(SPACE, "unknown", false);
    expect(known).toBe(flapped); // same thread regardless of whether the handle resolved
    expect(sessionKey(SPACE, "+16302101333", false)).toBe(sessionKey(SPACE, "unknown", false));
  });

  it("keeps GROUP threads per-sender, with unresolved members sharing the per-space 'unknown' bucket", () => {
    expect(threadOwner(SPACE, "+16302101333", true)).toBe("+16302101333");
    expect(threadOwner(SPACE, "+1999", true)).not.toBe(threadOwner(SPACE, "+16302101333", true));
    expect(threadOwner(SPACE, "unknown", true)).toBe("unknown");
    expect(threadOwner(SPACE, "", true)).toBe("unknown"); // empty handle collapses to the shared bucket
  });

  it("never collides a DM key with a group member's key in the same space", () => {
    expect(sessionKey(SPACE, "+16302101333", false)).not.toBe(sessionKey(SPACE, "+16302101333", true));
  });
});

describe("canRelaxSender", () => {
  it("always relaxes a DM (1:1, counterparty unambiguous even when the handle didn't resolve)", () => {
    expect(canRelaxSender("+16302101333", false)).toBe(true);
    expect(canRelaxSender("unknown", false)).toBe(true); // the fix: an unknown-handle DM follow-up still flows
  });

  it("relaxes a known group member but NEVER an unknown one (it shares the 'unknown' bucket)", () => {
    expect(canRelaxSender("+16302101333", true)).toBe(true);
    expect(canRelaxSender("unknown", true)).toBe(false);
  });
});

describe("actionableWhenRelaxed", () => {
  const intent = (over: Partial<Intent>): Intent => ({ kind: "search", via: "regex", ...over });

  it("continues a thread follow-up (next/link/answer) without a re-hail", () => {
    expect(actionableWhenRelaxed(intent({ kind: "next" }))).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "link", venue: "kalshi" }))).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "answer", reply: "it's a Messi prop" }))).toBe(true);
  });

  it("honors an EXPLICIT search (regex trigger) but not a bare-topic or LLM guess", () => {
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "oil prices", via: "regex" }))).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "argentina", via: "fallback" }))).toBe(false);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "argentina", via: "llm" }))).toBe(false);
  });

  it("stays silent on small talk / non-search intents overheard in a thread", () => {
    expect(actionableWhenRelaxed(intent({ kind: "other" }))).toBe(false);
  });
});

describe("SeenSet", () => {
  it("reports a message id as unseen once, then seen", () => {
    const s = new SeenSet(10);
    expect(s.seen("guid-1")).toBe(false);
    expect(s.seen("guid-1")).toBe(true);
    expect(s.seen("guid-2")).toBe(false);
  });

  it("evicts the oldest id past the cap (memory stays bounded)", () => {
    const s = new SeenSet(2);
    expect(s.seen("a")).toBe(false); // queue [a]
    expect(s.seen("b")).toBe(false); // queue [a, b]
    expect(s.seen("b")).toBe(true); // dedup hit — no growth
    expect(s.seen("c")).toBe(false); // queue [b, c]; evicts oldest "a"
    expect(s.seen("a")).toBe(false); // "a" was evicted → unseen again
  });
});
