/**
 * bench-search.ts — e2e latency benchmark for the cross-venue search CORE (`runSearch`).
 *
 * READ-ONLY: issues exactly the GET-based Sawa + pmxt reads the bot performs on every query.
 * No writes, no iMessage, no intent-LLM (runSearch is downstream of intent parsing, so this
 * measures the market-resolution core — the part caching actually affects).
 *
 * Per query it measures three conditions so we can attribute latency:
 *   - COLD      : pmxt cache cleared first → full Sawa fetch + fresh pmxt network calls
 *   - WARM      : immediate repeat → pmxt cache HIT, but Sawa feed is STILL refetched (bot
 *                 doesn't cache it today). The residual ≈ the uncached Sawa-feed cost.
 *   - SAWA-ONLY : runSearch with pmxt=null → isolates the Sawa feed fetch + client ranking.
 *
 * The COLD→WARM delta shows what the EXISTING in-process pmxt cache already saves.
 * The WARM / SAWA-ONLY floor is the target for the caching change (cache the Sawa read).
 *
 * Run:  npx tsx bench-search.ts            (uses ./.env — needs SAWA_API_BASE_URL; PMXT_API_KEY optional)
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig, getPmxtConfig } from "./src/sawa/config";
import { runSearch } from "./src/search";
import { __clearCache } from "./src/pmxt/discover";
import { __clearFeedCache } from "./src/sawa/read";

// ---- query sets ------------------------------------------------------------
const QUERIES: { cls: string; q: string; k: number }[] = [
  // World Cup class (the bot's headline use case)
  { cls: "worldcup", q: "world cup winner", k: 6 },
  { cls: "worldcup", q: "who will win the world cup", k: 6 },
  // Standard / non-world single-entity class
  { cls: "standard", q: "bitcoin", k: 6 },
  { cls: "standard", q: "super bowl winner", k: 6 },
  // Compound worst-case (documented to trigger entity decomposition → many serial pmxt calls)
  { cls: "compound", q: "mexico raul jimenez player props", k: 3 },
];

const PACE_MS = 700; // gap between pmxt-hitting iterations (stay under pmxt's ~55/min guard)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- stats -----------------------------------------------------------------
function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}
const round = (n: number) => Math.round(n);
const fmt = (vals: number[]) =>
  vals.length
    ? `p50=${round(pct(vals, 50))}ms p95=${round(pct(vals, 95))}ms min=${round(Math.min(...vals))} max=${round(Math.max(...vals))}`
    : "(no samples)";

type Sample = { ms: number; counts: string; errored: boolean; empty: boolean };

const config = getConfig();
const pmxt = getPmxtConfig();

async function timeOnce(query: string, withPmxt: boolean): Promise<Sample> {
  const t0 = performance.now();
  const r = await runSearch(query, { config, pmxt: withPmxt ? pmxt : null });
  const ms = performance.now() - t0;
  return {
    ms,
    counts: `${r.sawa.length}S/${r.kalshi.length}K/${r.polymarket.length}P`,
    errored: r.externalErrored,
    empty: r.empty,
  };
}

async function measure(query: string, k: number) {
  const cold: Sample[] = [];
  const warm: Sample[] = [];
  const sawaOnly: Sample[] = [];

  // discard one warmup (DNS/TLS/JIT)
  __clearCache();
  __clearFeedCache();
  await timeOnce(query, true);
  await sleep(PACE_MS);

  for (let i = 0; i < k; i++) {
    __clearCache();
    __clearFeedCache(); // COLD: force fresh pmxt + Sawa-feed fetch
    cold.push(await timeOnce(query, true));
    await sleep(PACE_MS);
    warm.push(await timeOnce(query, true)); // WARM: pmxt cache hit (Sawa still refetched)
    await sleep(PACE_MS);
  }
  // Sawa-only (no pmxt) — isolate the uncached Sawa feed cost (the caching target).
  for (let i = 0; i < k; i++) {
    sawaOnly.push(await timeOnce(query, false));
    await sleep(150);
  }
  return { query, cold, warm, sawaOnly };
}

// ---- run -------------------------------------------------------------------
const tStart = performance.now();
console.log(`# bench-search — ${config.apiBaseUrl}  pmxt=${pmxt ? "on" : "OFF"}\n`);

const byClass: Record<string, { cold: number[]; warm: number[]; sawaOnly: number[] }> = {};
const raw: Record<string, unknown>[] = [];

for (const { cls, q, k } of QUERIES) {
  const { cold, warm, sawaOnly } = await measure(q, k);
  const coldMs = cold.map((s) => s.ms);
  const warmMs = warm.map((s) => s.ms);
  const sawaMs = sawaOnly.map((s) => s.ms);
  const errRate = cold.filter((s) => s.errored).length / Math.max(1, cold.length);

  byClass[cls] ??= { cold: [], warm: [], sawaOnly: [] };
  byClass[cls]!.cold.push(...coldMs);
  byClass[cls]!.warm.push(...warmMs);
  byClass[cls]!.sawaOnly.push(...sawaMs);

  console.log(`[${cls}] "${q}"  (n=${k}, results=${cold[0]?.counts ?? "?"}${cold[0]?.empty ? " EMPTY" : ""}${errRate ? `, pmxt-errored=${Math.round(errRate * 100)}%` : ""})`);
  console.log(`   COLD      ${fmt(coldMs)}`);
  console.log(`   WARM      ${fmt(warmMs)}`);
  console.log(`   SAWA-ONLY ${fmt(sawaMs)}\n`);

  raw.push({ cls, q, k, coldMs, warmMs, sawaMs, errRate, counts: cold[0]?.counts });
}

console.log("=== CLASS SUMMARY ===");
for (const [cls, v] of Object.entries(byClass)) {
  const coldP50 = pct(v.cold, 50);
  const warmP50 = pct(v.warm, 50);
  const saved = coldP50 ? round((1 - warmP50 / coldP50) * 100) : 0;
  console.log(`[${cls}]`);
  console.log(`   COLD      ${fmt(v.cold)}`);
  console.log(`   WARM      ${fmt(v.warm)}   (existing pmxt cache saves ~${saved}% p50 vs cold)`);
  console.log(`   SAWA-ONLY ${fmt(v.sawaOnly)}`);
}

console.log(`\n# done in ${round((performance.now() - tStart) / 1000)}s`);
console.log("\n=== RAW JSON ===");
console.log(JSON.stringify(raw));
