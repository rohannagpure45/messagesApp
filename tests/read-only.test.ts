import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The bot's invariant is "writes only through the authenticated API" (AGENTS.md). Two surfaces must
// stay structurally read-only, and this suite enforces both statically:
//   1. The Sawa DISCOVERY READ PATH (src/sawa/read.ts + the getJson helper) — GET-only, NO database
//      credentials (post Option C, task 0.6).
//   2. The pmxt ENRICHMENT CLIENT (src/pmxt/*) — GET-only, and it must NEVER reference the trade host
//      (trade.pmxt.dev / EIP-712), which would turn the bot into a real-money broker.
const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const WRITE_METHOD = /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)/i;

const read = (...parts: string[]) => readFileSync(join(SRC_DIR, ...parts), "utf8");

describe("discovery read path is GET-only", () => {
  const readTs = read("sawa", "read.ts");
  const httpTs = read("sawa", "http.ts");
  const configTs = read("sawa", "config.ts");

  it("read.ts issues no write HTTP methods", () => {
    expect(WRITE_METHOD.test(readTs)).toBe(false);
  });

  it("read.ts goes through the getJson helper — no raw fetch()", () => {
    expect(readTs).toMatch(/\bgetJson</);
    expect(readTs).not.toMatch(/\bfetch\s*\(/);
  });

  it("the getJson helper pins its method to GET and writes nothing", () => {
    expect(httpTs).toMatch(/method\s*:\s*["'`]GET/);
    expect(WRITE_METHOD.test(httpTs)).toBe(false);
  });

  it("the read path itself carries NO Supabase / PostgREST credentials (Option C)", () => {
    // The read path proper is read.ts + the getJson helper — these must never inject an
    // apikey/anon-key header. (config.ts legitimately holds pmxt/intent API keys now, so it is
    // checked separately below for Supabase specifics only.)
    const readPath = readTs + httpTs;
    expect(readPath).not.toMatch(/supabase/i);
    expect(readPath).not.toMatch(/rest\/v1/i);
    expect(readPath).not.toMatch(/apikey/i);
    expect(readPath).not.toMatch(/anon[_-]?key/i);
  });

  it("config.ts holds no Supabase/PostgREST credentials (pmxt/intent keys are fine)", () => {
    expect(configTs).not.toMatch(/supabase/i);
    expect(configTs).not.toMatch(/rest\/v1/i);
    expect(configTs).not.toMatch(/anon[_-]?key/i);
  });

  it("reads are built from the configured app base URL, not a hard-coded host", () => {
    expect(readTs).toMatch(/\/api\/predictions/);
    expect(readTs).toMatch(/apiBaseUrl|apiUrl\(/);
    // No raw scheme+host literal in the read path (all URLs come from cfg.apiBaseUrl).
    expect(readTs).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe("pmxt enrichment client is GET-only and never the trade host", () => {
  const pmxtHttp = read("pmxt", "http.ts");
  const pmxtDiscover = read("pmxt", "discover.ts");
  const combined = pmxtHttp + pmxtDiscover;

  it("issues no write HTTP methods", () => {
    expect(WRITE_METHOD.test(pmxtHttp)).toBe(false);
    expect(WRITE_METHOD.test(pmxtDiscover)).toBe(false);
  });

  it("the pmxt http helper pins its method to GET", () => {
    expect(pmxtHttp).toMatch(/method\s*:\s*["'`]GET/);
  });

  it("never references the trade host or signing (real-money broker surface)", () => {
    expect(combined).not.toMatch(/trade\.pmxt/i);
    expect(combined).not.toMatch(/eip-?712/i);
    expect(combined).not.toMatch(/usdc/i);
    expect(combined).not.toMatch(/privateKey/i);
  });

  it("discover.ts reads through the GET-only helper — no raw fetch()", () => {
    expect(pmxtDiscover).toMatch(/\bgetJson</);
    expect(pmxtDiscover).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("read config contract", () => {
  it("getConfig requires SAWA_API_BASE_URL and strips trailing slashes", async () => {
    const { getConfig, ConfigError } = await import("../src/sawa/config");
    expect(() => getConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    const cfg = getConfig({ SAWA_API_BASE_URL: "https://sawa.test///" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiBaseUrl).toBe("https://sawa.test");
  });

  it("getPmxtConfig / getIntentConfig return null when their keys are unset", async () => {
    const { getPmxtConfig, getIntentConfig } = await import("../src/sawa/config");
    expect(getPmxtConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(getIntentConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("createStub", () => {
  it("never reports a real creation", async () => {
    const { stubCreate } = await import("../src/sawa/createStub");
    const r = stubCreate("Will the Lakers win?", ["Yes", "No"]);
    expect(r.created).toBe(false);
    expect(r.stub).toBe(true);
    expect(r.message.toLowerCase()).toContain("nothing was created");
  });
});
