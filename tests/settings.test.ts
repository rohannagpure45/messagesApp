import { describe, it, expect } from "vitest";
import {
  classifySettingCommand,
  peelSettings,
  isSettingsQuery,
  SpaceSettings,
  confirmChanges,
  describeSettings,
  SETTING_KEYS,
} from "../src/sawa/settings";

describe("classifySettingCommand", () => {
  it("recognizes quips on across phrasings", () => {
    for (const m of [
      "quips on",
      "turn on the quips",
      "turn the quips on",
      "enable quips",
      "quips please",
      "more banter",
      "jokes on",
      "add some flair",
    ]) {
      expect(classifySettingCommand(m)).toEqual({ key: "quips", on: true });
    }
  });

  it("recognizes quips off across phrasings", () => {
    for (const m of [
      "quips off",
      "turn off the quips",
      "turn the quips off",
      "disable quips",
      "no quips",
      "stop the jokes",
      "mute the banter",
      "no more jokes",
    ]) {
      expect(classifySettingCommand(m)).toEqual({ key: "quips", on: false });
    }
  });

  it("recognizes external-markets on/off (incl. sawa-only)", () => {
    for (const m of ["all venues", "external on", "enable external", "include external markets", "external markets on"]) {
      expect(classifySettingCommand(m)).toEqual({ key: "external", on: true });
    }
    for (const m of ["external off", "disable external", "only sawa", "only sawa markets", "sawa only", "hide external markets", "kalshi off"]) {
      expect(classifySettingCommand(m)).toEqual({ key: "external", on: false });
    }
  });

  it("returns null for non-commands — a subject with no direction, or a real search/venue word", () => {
    for (const m of ["quips", "world cup", "find cap and trade", "kalshi", "show me kalshi markets", "comedian quips odds", ""]) {
      expect(classifySettingCommand(m)).toBeNull();
    }
  });
});

describe("peelSettings (compound toggle + remainder — the Issue 5 symptom)", () => {
  it("peels a leading toggle and returns the remaining message to be searched", () => {
    expect(peelSettings("turn on the quips, look for bitcoin")).toEqual({
      changes: [{ key: "quips", on: true }],
      rest: "look for bitcoin",
    });
    expect(peelSettings("quips off and find me dogecoin")).toEqual({
      changes: [{ key: "quips", on: false }],
      rest: "find me dogecoin",
    });
  });

  it("peels multiple leading toggles in order", () => {
    expect(peelSettings("quips on, sawa only, world cup")).toEqual({
      changes: [
        { key: "quips", on: true },
        { key: "external", on: false },
      ],
      rest: "world cup",
    });
  });

  it("returns an empty remainder for a standalone toggle", () => {
    expect(peelSettings("quips off")).toEqual({ changes: [{ key: "quips", on: false }], rest: "" });
  });

  it("never splits a real search that merely contains 'and' / ','", () => {
    expect(peelSettings("find cap and trade")).toEqual({ changes: [], rest: "find cap and trade" });
    expect(peelSettings("Switzerland, India")).toEqual({ changes: [], rest: "Switzerland, India" });
    expect(peelSettings("look for player props on Raul Jimenez")).toEqual({
      changes: [],
      rest: "look for player props on Raul Jimenez",
    });
  });
});

describe("isSettingsQuery", () => {
  it("matches a settings READ, not a toggle or a search", () => {
    for (const m of ["settings", "show settings", "what are your settings", "my settings", "settings?"]) {
      expect(isSettingsQuery(m)).toBe(true);
    }
    for (const m of ["quips on", "world cup", "setting a record", "sawa only"]) {
      expect(isSettingsQuery(m)).toBe(false);
    }
  });
});

describe("SpaceSettings", () => {
  it("returns the env default until overridden, then sticks across repeated reads", () => {
    const s = new SpaceSettings({ quips: false, external: true });
    expect(s.get("A", "quips")).toBe(false);
    expect(s.get("A", "external")).toBe(true);
    s.set("A", "quips", true);
    expect(s.get("A", "quips")).toBe(true);
    expect(s.get("A", "quips")).toBe(true); // sticky — does NOT revert between reads (persists across searches)
  });

  it("keys per space (no cross-space leak) and overrides back to off", () => {
    const s = new SpaceSettings({ quips: false, external: true });
    s.set("A", "quips", true);
    expect(s.get("B", "quips")).toBe(false); // independent of A
    s.set("A", "quips", false);
    expect(s.get("A", "quips")).toBe(false);
  });

  it("LRU-evicts the oldest space past the cap (memory hygiene, no TTL revert)", () => {
    const s = new SpaceSettings({ quips: false, external: true }, 2);
    s.set("A", "quips", true);
    s.set("B", "quips", true);
    s.set("C", "quips", true); // A is the oldest → evicted
    expect(s.get("A", "quips")).toBe(false); // reverted to default
    expect(s.get("C", "quips")).toBe(true);
  });

  it("resolved() reports every registered setting", () => {
    const s = new SpaceSettings({ quips: true, external: false });
    expect(s.resolved("A")).toEqual({ quips: true, external: false });
    expect(SETTING_KEYS).toEqual(["quips", "external"]);
  });
});

describe("reply copy", () => {
  it("confirmChanges describes each applied toggle", () => {
    expect(confirmChanges([{ key: "quips", on: true }])).toMatch(/quips on/i);
    expect(confirmChanges([{ key: "external", on: false }])).toMatch(/sawa only/i);
    const both = confirmChanges([
      { key: "quips", on: false },
      { key: "external", on: true },
    ]);
    expect(both).toMatch(/quips off/i);
    expect(both).toMatch(/external markets on/i);
  });

  it("describeSettings lists the current per-space values", () => {
    const reply = describeSettings({ quips: true, external: false });
    expect(reply).toMatch(/quips: on/i);
    expect(reply).toMatch(/external markets: off/i);
  });
});
