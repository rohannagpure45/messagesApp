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

describe("cloud / business-line compatibility (the helpers key only on isGroup + space + handle)", () => {
  // These helpers carry NO local-vs-cloud branch — they take exactly what Spectrum gives every provider
  // (isGroup, space.id, a normalized handle). On a cloud/business line handles resolve reliably (no
  // chat.db flapping), so the same logic that fixes LOCAL still does the right thing on cloud.
  const SPACE = "biz-space";

  it("a cloud DM (handle resolves consistently) keeps one stable thread, and its clarify owner matches", () => {
    // Both the question and the answer carry the same resolved handle on cloud → same thread + owner.
    expect(sessionKey(SPACE, "+1555", false)).toBe(sessionKey(SPACE, "+1555", false));
    expect(threadOwner(SPACE, "+1555", false)).toBe(threadOwner(SPACE, "+1555", false));
    // …and because a DM binds to the space, it would still match even if cloud ever spelled it differently.
    expect(threadOwner(SPACE, "+1555", false)).toBe(threadOwner(SPACE, "unknown", false));
  });

  it("a cloud/business GROUP gives each resolved member their own thread (the reason to use a business line)", () => {
    const alice = sessionKey(SPACE, "+1alice", true);
    const bob = sessionKey(SPACE, "+1bob", true);
    expect(alice).not.toBe(bob); // distinct per-member threads
    expect(canRelaxSender("+1alice", true)).toBe(true); // resolved members relax hail-free
    // Only the asker owns their pending clarify; a different member can't answer it.
    expect(threadOwner(SPACE, "+1alice", true)).not.toBe(threadOwner(SPACE, "+1bob", true));
  });
});

describe("actionableWhenRelaxed", () => {
  const intent = (over: Partial<Intent>): Intent => ({ kind: "search", via: "regex", ...over });
  const DM = false;
  const GROUP = true;

  it("continues a thread follow-up (next/link/answer) without a re-hail, in any space", () => {
    for (const g of [DM, GROUP]) {
      expect(actionableWhenRelaxed(intent({ kind: "next" }), g)).toBe(true);
      expect(actionableWhenRelaxed(intent({ kind: "link", venue: "kalshi" }), g)).toBe(true);
      expect(actionableWhenRelaxed(intent({ kind: "answer", reply: "it's a Messi prop" }), g)).toBe(true);
    }
  });

  it("in a GROUP honors only an EXPLICIT search (regex trigger), not a bare-topic / LLM guess", () => {
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "oil prices", via: "regex" }), GROUP)).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "argentina", via: "fallback" }), GROUP)).toBe(false);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "argentina", via: "llm" }), GROUP)).toBe(false);
  });

  it("in a DM honors ANY search — a bare topic / LLM refinement IS a bot-directed message (the dropped-follow-up fix)", () => {
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "oil prices", via: "regex" }), DM)).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "s&p price range", via: "llm" }), DM)).toBe(true);
    expect(actionableWhenRelaxed(intent({ kind: "search", query: "argentina", via: "fallback" }), DM)).toBe(true);
  });

  it("stays silent on small talk / non-search intents overheard in a thread (DM and group)", () => {
    expect(actionableWhenRelaxed(intent({ kind: "other" }), DM)).toBe(false);
    expect(actionableWhenRelaxed(intent({ kind: "other" }), GROUP)).toBe(false);
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
