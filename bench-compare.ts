/**
 * bench-compare.ts — "cached market IDs vs NOT cached", through the bot's runSearch flow + pmxt.
 *
 * Two real topics the user picked:
 *   CACHED   — World Cup, Germany vs Paraguay (Kalshi KXWCADVANCE-GERPAR + Polymarket FIFWC-GER-PAR).
 *              Pre-warmed each iteration, so its market IDs are served from the pmxt cache (HIT).
 *   UNCACHED — Democratic Presidential Nominee 2028 (Kalshi KXPRESNOMD-28 + Polymarket).
 *              Never warmed → a cold pmxt fetch every time (MISS).
 * The (query-independent) Sawa feed is warmed once and shared, so the ONLY variable is the pmxt
 * market-id cache — i.e. this isolates exactly what "caching market IDs" buys.
 *
 * Run:  npx tsx bench-compare.ts        (needs SAWA_API_BASE_URL + PMXT_API_KEY in ./.env)
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig, getPmxtConfig } from "./src/sawa/config";
import { runSearch } from "./src/search";
import { __clearCache } from "./src/pmxt/discover";
import { __clearFeedCache } from "./src/sawa/read";

const config = getConfig();
const pmxt = getPmxtConfig();
if (!pmxt) {
  console.error("PMXT_API_KEY required for this bench.");
  process.exit(1);
}

// Count pmxt network calls so we can show "0 calls (cached)" vs "N calls (uncached)".
let pmxtCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL, i?: RequestInit) => {
  if (String(u).includes("api.pmxt.dev")) pmxtCalls++;
  return realFetch(u as never, i as never);
}) as typeof fetch;

const WC = "germany paraguay"; // World Cup GER-PAR     → CACHED
const DEM = "democratic presidential nominee 2028"; // Dem nominee 2028 → NOT CACHED
const K = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const r0 = (n: number) => Math.round(n);
async function run(q: string) {
  const t = performance.now();
  const res = await runSearch(q, { config, pmxt });
  return { ms: performance.now() - t, res };
}

// Warm the query-independent Sawa feed once so it's a HIT for both topics — isolates the pmxt cache.
__clearCache();
__clearFeedCache();
await run(WC);

const wc: number[] = [];
const wcCalls: number[] = [];
const dem: number[] = [];
const demCalls: number[] = [];
let wcTitles: string[] = [];
let demTitles: string[] = [];

for (let i = 0; i < K; i++) {
  __clearCache(); // both topics cold in the pmxt cache
  await run(WC); // warm ONLY the World Cup topic → its market IDs are now cached
  pmxtCalls = 0;
  const a = await run(WC); // measure CACHED World Cup → pmxt HIT
  wc.push(a.ms);
  wcCalls.push(pmxtCalls);
  if (!wcTitles.length) wcTitles = [...a.res.kalshi, ...a.res.polymarket].map((m) => m.title).slice(0, 3);
  await sleep(800);

  pmxtCalls = 0;
  const b = await run(DEM); // measure NOT-CACHED Democratic → pmxt MISS
  dem.push(b.ms);
  demCalls.push(pmxtCalls);
  if (!demTitles.length) demTitles = [...b.res.kalshi, ...b.res.polymarket].map((m) => m.title).slice(0, 3);
  await sleep(800);
}

console.log(`# bench-compare — cached vs NOT-cached market IDs (our flow + pmxt) — ${config.apiBaseUrl}\n`);
console.log(`CACHED   topic: World Cup, Germany vs Paraguay   (q="${WC}")`);
console.log(`  matched: ${JSON.stringify(wcTitles)}`);
console.log(`  e2e p50 ${r0(pct(wc, 50))}ms    pmxt network calls/query: ${pct(wcCalls, 50)}\n`);
console.log(`UNCACHED topic: Democratic Nominee 2028          (q="${DEM}")`);
console.log(`  matched: ${JSON.stringify(demTitles)}`);
console.log(`  e2e p50 ${r0(pct(dem, 50))}ms    pmxt network calls/query: ${pct(demCalls, 50)}\n`);
const wcP = pct(wc, 50);
const demP = pct(dem, 50);
console.log(
  `→ cached is ${(demP / Math.max(1, wcP)).toFixed(1)}x faster (${r0((1 - wcP / demP) * 100)}% lower e2e), ` +
    `${pct(demCalls, 50) - pct(wcCalls, 50)} fewer pmxt calls/query`,
);
console.log(`\nraw  wc ms: ${wc.map(r0)}   dem ms: ${dem.map(r0)}`);
