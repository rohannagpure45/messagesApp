import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The bot's invariant is "writes only through the authenticated API" (AGENTS.md). This suite
// narrows that to the one surface that must stay read-only: the DISCOVERY READ PATH
// (src/sawa/read.ts + the getJson helper in src/sawa/http.ts). It must issue GET only and,
// after the Option C move (task 0.6), hold NO database credentials.
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

  it("the read path holds no Supabase / PostgREST credentials (Option C)", () => {
    // Cover the whole read path — read.ts, config.ts AND the http helper — so a reintroduced
    // apikey/anon-key default header in getJson can't slip through.
    const combined = readTs + configTs + httpTs;
    expect(combined).not.toMatch(/supabase/i);
    expect(combined).not.toMatch(/rest\/v1/i);
    expect(combined).not.toMatch(/apikey/i);
    expect(combined).not.toMatch(/anon[_-]?key/i);
  });

  it("reads are built from the configured app base URL, not a hard-coded host", () => {
    expect(readTs).toMatch(/\/api\/predictions/);
    expect(readTs).toMatch(/apiBaseUrl|apiUrl\(/);
    // No raw scheme+host literal in the read path (all URLs come from cfg.apiBaseUrl).
    expect(readTs).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe("read config contract", () => {
  it("getConfig requires SAWA_API_BASE_URL and strips trailing slashes", async () => {
    const { getConfig, ConfigError } = await import("../src/sawa/config");
    expect(() => getConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    const cfg = getConfig({ SAWA_API_BASE_URL: "https://sawa.test///" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiBaseUrl).toBe("https://sawa.test");
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
