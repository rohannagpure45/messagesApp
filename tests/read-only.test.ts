import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Static guarantee: nothing anywhere in src/ issues a write HTTP method.
const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const WRITE_METHOD = /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)/i;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("read-only by construction", () => {
  it("no write HTTP methods anywhere in src/ (incl. index.ts, env.ts)", () => {
    const offenders = tsFiles(SRC_DIR).filter((f) => WRITE_METHOD.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the http helper pins its method to GET", () => {
    const src = readFileSync(join(SRC_DIR, "sawa", "http.ts"), "utf8");
    expect(src).toMatch(/method\s*:\s*["'`]GET/);
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
