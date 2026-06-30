/**
 * bench-c.ts — end-to-end latency win + the follow-up C resilience demo, run LIVE against Sawa +
 * pmxt (read-only GETs). Two parts:
 *   PART 1 — e2e COLD (both caches cleared) vs WARM (both hot): the caching latency win, end-to-end
 *            (Sawa feed cache A + the pmxt cache, both venues).
 *   PART 2 — C (durable pmxt cache): after a simulated RESTART, the pmxt cache rehydrates from disk
 *            so the cold-start pmxt burst is avoided (no 429 storm), vs a no-persistence cold start.
 *
 * Run:  npx tsx bench-c.ts        (needs SAWA_API_BASE_URL + PMXT_API_KEY in ./.env)
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import { getConfig, getPmxtConfig } from "./src/sawa/config";
import { runSearch } from "./src/search";
import { __clearCache, __setCachePersistence, enableCachePersistence, fileCachePersistence } from "./src/pmxt/discover";
import { __clearFeedCache, __setFeedCachePersistence, enableFeedCachePersistence, fileFeedCachePersistence } from "./src/sawa/read";

const config = getConfig();
const pmxt = getPmxtConfig();
if (!pmxt) {
  console.error("PMXT_API_KEY not set — this bench needs pmxt on.");
  process.exit(1);
}

// Count pmxt network calls so PART 2 can show "calls avoided on restart".
let pmxtCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
  if (String(url).includes("api.pmxt.dev")) pmxtCalls++;
  return realFetch(url as never, init as never);
}) as typeof fetch;

const QUERIES = [
  { cls: "worldcup", q: "world cup winner" },
  { cls: "worldcup", q: "who will win the world cup" },
  { cls: "standard", q: "bitcoin" },
  { cls: "standard", q: "super bowl winner" },
];
const K = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const r0 = (n: number) => Math.round(n);
async function timeOnce(q: string): Promise<number> {
  const t = performance.now();
  await runSearch(q, { config, pmxt });
  return performance.now() - t;
}

console.log(`# bench-c — e2e (Sawa + pmxt) — ${config.apiBaseUrl}\n`);
console.log("## PART 1 — e2e COLD (uncached) vs WARM (cached)\n");
for (const { cls, q } of QUERIES) {
  const cold: number[] = [];
  const warm: number[] = [];
  for (let i = 0; i < K; i++) {
    __clearCache();
    __clearFeedCache();
    __setCachePersistence(null);
    cold.push(await timeOnce(q));
    await sleep(700);
    warm.push(await timeOnce(q));
    await sleep(700);
  }
  const c = pct(cold, 50);
  const w = pct(warm, 50);
  console.log(`[${cls}] "${q}"  COLD p50 ${r0(c)}ms  →  WARM p50 ${r0(w)}ms   (${r0((1 - w / c) * 100)}% faster)`);
}

console.log("\n## PART 2 — durable caches survive a restart (full warm cold start)\n");
const pmxtCacheFile = `${process.cwd()}/.sawa/bench-pmxt-cache.json`;
const feedCacheFile = `${process.cwd()}/.sawa/bench-feed-cache.json`;
fs.rmSync(pmxtCacheFile, { force: true });
fs.rmSync(feedCacheFile, { force: true });
const q0 = QUERIES[0]!.q;

// Warm WITH durable persistence enabled (writes both the pmxt and Sawa-feed caches to disk).
__clearCache();
__clearFeedCache();
enableCachePersistence(fileCachePersistence(pmxtCacheFile));
enableFeedCachePersistence(fileFeedCachePersistence(feedCacheFile));
await timeOnce(q0);
await sleep(700);

// Simulate a RESTART: drop ALL in-memory caches, then rehydrate BOTH from disk.
__clearCache();
__clearFeedCache();
enableCachePersistence(fileCachePersistence(pmxtCacheFile));
enableFeedCachePersistence(fileFeedCachePersistence(feedCacheFile));
pmxtCalls = 0;
const restartMs = await timeOnce(q0);
const restartCalls = pmxtCalls;
await sleep(700);

// Control: a cold restart WITHOUT any persistence.
__clearCache();
__clearFeedCache();
__setCachePersistence(null);
__setFeedCachePersistence(null);
pmxtCalls = 0;
const coldMs = await timeOnce(q0);
const coldCalls = pmxtCalls;
fs.rmSync(pmxtCacheFile, { force: true });
fs.rmSync(feedCacheFile, { force: true });

console.log(`"${q0}"`);
console.log(`  restart WITH durable caches (pmxt + feed) : ${r0(restartMs)}ms,  pmxt network calls = ${restartCalls}`);
console.log(`  cold restart, no persistence              : ${r0(coldMs)}ms,  pmxt network calls = ${coldCalls}`);
console.log(`  → after restart: ${r0((1 - restartMs / coldMs) * 100)}% faster, ${coldCalls - restartCalls} pmxt calls avoided`);
console.log(`\n(Both caches rehydrate from disk, so the first query after a restart is served entirely from`);
console.log(` disk — no Sawa or pmxt network — vs a cold start that re-fetches both.)`);
