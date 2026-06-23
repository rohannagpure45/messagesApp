import { describe, it, expect } from "vitest";
import { mentionsBot, shouldHandle, SeenSet } from "../src/routing";

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

describe("shouldHandle", () => {
  it("always handles slash commands and DMs; gates group chatter on a mention", () => {
    expect(shouldHandle({ isGroup: true, isSlash: true, body: "/search x", botName: "sawa" })).toBe(true);
    expect(shouldHandle({ isGroup: false, isSlash: false, body: "world cup", botName: "sawa" })).toBe(true); // DM
    expect(shouldHandle({ isGroup: true, isSlash: false, body: "sawa world cup", botName: "sawa" })).toBe(true);
    expect(shouldHandle({ isGroup: true, isSlash: false, body: "lol nice game", botName: "sawa" })).toBe(false);
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
