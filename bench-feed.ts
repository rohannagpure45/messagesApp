/**
 * bench-feed.ts — isolates the Sawa-feed cache effect (the change in this PR).
 *
 * Measures runSearch() with pmxt=null (Sawa path only): COLD (feed cache cleared each run) vs
 * WARM (feed cache hot). Sawa and PMXT run in PARALLEL inside runSearch and the Sawa GET (~1s)
 * was the long pole, so this is the honest before/after of what the cache removes — and it's
 * PMXT-immune, so it stays clean even when the pmxt free tier is rate-limited.
 *
 * Run:  npx tsx bench-feed.ts
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig } from "./src/sawa/config";
import { runSearch } from "./src/search";
import { __clearFeedCache } from "./src/sawa/read";

const config = getConfig();
const QUERIES = [
  { cls: "worldcup", q: "world cup winner" },
  { cls: "worldcup", q: "who will win the world cup" },
  { cls: "standard", q: "bitcoin" },
  { cls: "standard", q: "super bowl winner" },
];
const K = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pct(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
const r0 = (n: number) => Math.round(n);
const fmt = (v: number[]) =>
  v.length ? `p50=${r0(pct(v, 50))}ms p95=${r0(pct(v, 95))}ms min=${r0(Math.min(...v))} max=${r0(Math.max(...v))}` : "(none)";

async function timeOnce(q: string): Promise<number> {
  const t = performance.now();
  await runSearch(q, { config, pmxt: null });
  return performance.now() - t;
}

console.log(`# bench-feed (Sawa path only, pmxt=null) — ${config.apiBaseUrl}\n`);
for (const { cls, q } of QUERIES) {
  const cold: number[] = [];
  const warm: number[] = [];
  for (let i = 0; i < K; i++) {
    __clearFeedCache();
    cold.push(await timeOnce(q));
    await sleep(120);
  }
  __clearFeedCache();
  await timeOnce(q); // populate cache
  for (let i = 0; i < K; i++) warm.push(await timeOnce(q));
  const c = pct(cold, 50);
  const w = pct(warm, 50);
  const red = c ? r0((1 - w / c) * 100) : 0;
  console.log(`[${cls}] "${q}"`);
  console.log(`   COLD ${fmt(cold)}`);
  console.log(`   WARM ${fmt(warm)}   → ${red}% p50 reduction`);
}
