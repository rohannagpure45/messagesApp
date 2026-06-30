/**
 * bench-ask.ts — REAL-WORLD turn: a user asks a price/odds question, measured end-to-end from
 * inbound text to the reply body that gets sent back (the only thing left is the Spectrum/iMessage
 * network send, which is constant and cache-independent).
 *
 * Pipeline mirrors index.ts runConversationalSearch: parseIntent → runSearch (resolves the market
 * AND carries its current price/odds) → flattenRanked → nextTurn (render the priced one-liner).
 * The market-id cache only affects the runSearch step; intent + render are constant, so this shows
 * the cache's effect on the whole turn.
 *
 * CACHED   = World Cup Germany vs Paraguay (pre-warmed each iteration).
 * UNCACHED = Democratic Nominee 2028 (never warmed → cold pmxt fetch).
 *
 * Run:  npx tsx bench-ask.ts
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig, getPmxtConfig, getIntentConfig } from "./src/sawa/config";
import { runSearch, flattenRanked } from "./src/search";
import { parseIntent } from "./src/sawa/intent";
import { nextTurn } from "./src/sawa/conversation";
import { __clearCache } from "./src/pmxt/discover";
import { __clearFeedCache } from "./src/sawa/read";

const config = getConfig();
const pmxt = getPmxtConfig();
const intentConfig = getIntentConfig();
if (!pmxt) {
  console.error("PMXT_API_KEY required for this bench.");
  process.exit(1);
}

const WC = "what are the odds on germany vs paraguay";
const DEM = "what are the odds on the democratic presidential nominee 2028";
const K = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const r0 = (n: number) => Math.round(n);

/** Run the full turn for a question; return per-step timings + the reply body that would be sent. */
async function ask(text: string) {
  const t0 = performance.now();
  const intent = await parseIntent(text, config.botName, intentConfig);
  const t1 = performance.now();
  const query = (intent.kind === "search" ? intent.query : undefined) ?? text;
  const results = await runSearch(query, { config, pmxt });
  const t2 = performance.now();
  flattenRanked(results);
  const outcome = nextTurn(null, { kind: "search", query, via: "regex" }, results, { folkTone: false });
  const t3 = performance.now();
  return { intentMs: t1 - t0, searchMs: t2 - t1, renderMs: t3 - t2, totalMs: t3 - t0, body: outcome.body };
}

// Warm the query-independent Sawa feed once (HIT for both) — isolates the pmxt market-id cache.
__clearCache();
__clearFeedCache();
await ask(WC);

type Step = { intent: number[]; search: number[]; total: number[] };
const wc: Step = { intent: [], search: [], total: [] };
const dem: Step = { intent: [], search: [], total: [] };
let wcBody = "";
let demBody = "";

for (let i = 0; i < K; i++) {
  __clearCache(); // both topics cold in the pmxt cache
  await ask(WC); // warm ONLY the World Cup topic (its exact extracted query) → market IDs cached
  const a = await ask(WC); // measure CACHED price question
  wc.intent.push(a.intentMs);
  wc.search.push(a.searchMs);
  wc.total.push(a.totalMs);
  if (!wcBody) wcBody = a.body;
  await sleep(800);

  const b = await ask(DEM); // measure NOT-CACHED price question
  dem.intent.push(b.intentMs);
  dem.search.push(b.searchMs);
  dem.total.push(b.totalMs);
  if (!demBody) demBody = b.body;
  await sleep(800);
}

const line = (label: string, s: Step) =>
  `${label}  total p50 ${r0(pct(s.total, 50))}ms   = intent ${r0(pct(s.intent, 50))}ms + resolve ${r0(pct(s.search, 50))}ms (+render ~0ms)`;

console.log(`# bench-ask — real-world price question, end-to-end to reply-ready — ${config.apiBaseUrl}\n`);
console.log("## CACHED — World Cup, Germany vs Paraguay");
console.log(line("  ", wc));
console.log(`  reply: ${JSON.stringify(wcBody.slice(0, 180))}\n`);
console.log("## UNCACHED — Democratic Nominee 2028");
console.log(line("  ", dem));
console.log(`  reply: ${JSON.stringify(demBody.slice(0, 180))}\n`);

const wcTot = pct(wc.total, 50);
const demTot = pct(dem.total, 50);
const wcS = pct(wc.search, 50);
const demS = pct(dem.search, 50);
console.log(
  `→ caching the market ID cuts the RESOLVE step ${r0(demS)}ms → ${r0(wcS)}ms, so the whole turn is ` +
    `${r0(demTot)}ms → ${r0(wcTot)}ms (${r0(demTot - wcTot)}ms / ${r0((1 - wcTot / demTot) * 100)}% faster to reply-ready).`,
);
console.log(`\nraw  wc total ms: ${wc.total.map(r0)}   dem total ms: ${dem.total.map(r0)}`);
