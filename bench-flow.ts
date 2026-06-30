/**
 * bench-flow.ts — walk the ENTIRE iMessage turn for a bare matchup query (as-is, cold), timing every
 * step from "message received" to "reply ready to send". Mirrors index.ts runConversationalSearch:
 *   routing/gating → parseIntent → runSearch (resolve + price) → clarify decide(+LLM refine) → render.
 *
 * Bare matchups ("Wu versus Djokovic") have NO search-trigger word, so the regex gate is NOT confident
 * and parseIntent falls through to the Gemini LLM (unlike "odds on X", which the regex gate resolves in
 * ~0 ms). On a clarify turn there is a SECOND Gemini call (refineClarify).
 *
 * COLD clears ALL four caches before each run (the true first-time flow); CACHED warms once so the
 * repeat turn hits every cache: the market-id + feed caches (resolve step) AND — new here — the
 * cold-start intent cache + the clarify-decision cache (both Gemini calls). This isolates the
 * repeat-hit win of caching the intent classification, the same way bench-compare did for market IDs.
 *
 * Run:  npx tsx bench-flow.ts
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig, getPmxtConfig, getIntentConfig } from "./src/sawa/config";
import { runSearch, flattenRanked } from "./src/search";
import { parseIntent, refineClarify, __clearIntentCache, __clearClarifyCache } from "./src/sawa/intent";
import { nextTurn, pickedAnswer } from "./src/sawa/conversation";
import { decideClarify, renderClarifyText } from "./src/sawa/clarify";
import { __clearCache } from "./src/pmxt/discover";
import { __clearFeedCache } from "./src/sawa/read";

const config = getConfig();
const pmxt = getPmxtConfig();
const intentConfig = getIntentConfig();
if (!pmxt) {
  console.error("PMXT_API_KEY required.");
  process.exit(1);
}

interface Walk {
  intentMs: number;
  intentVia: string;
  resolveMs: number;
  clarifyMs: number;
  renderMs: number;
  totalMs: number;
  path: string;
  body: string;
  venues: string;
}

async function turn(text: string): Promise<Walk> {
  const t0 = performance.now();
  const intent = await parseIntent(text, config.botName, intentConfig); // step 1: intent (regex gate → Gemini fallback)
  const t1 = performance.now();
  const query = (intent.kind === "search" ? intent.query : undefined) ?? text;
  const results = await runSearch(query, { config, pmxt }); // step 2: resolve market + price
  const candidates = results.empty ? [] : flattenRanked(results);
  const t2 = performance.now();
  let question = candidates.length ? decideClarify(candidates, query) : null; // step 3: clarify decide
  if (question && intentConfig) question = await refineClarify(query, question, intentConfig); // ...+ Gemini refine
  const t3 = performance.now();
  let path: string;
  let body: string; // step 4: render the reply that gets sent
  if (question && question.options.length >= 2) {
    body = renderClarifyText(question);
    path = "clarify (poll/list)";
  } else if (question && question.options.length === 1) {
    body = pickedAnswer(query, candidates, results, question.options[0]!.result, { folkTone: false }).body;
    path = "answer (LLM-narrowed)";
  } else {
    body = nextTurn(null, { kind: "search", query, via: "regex" }, results, { folkTone: false }).body;
    path = candidates.length ? "answer (single best)" : "empty-state";
  }
  const t4 = performance.now();
  return {
    intentMs: t1 - t0,
    intentVia: intent.via,
    resolveMs: t2 - t1,
    clarifyMs: t3 - t2,
    renderMs: t4 - t3,
    totalMs: t4 - t0,
    path,
    body,
    venues: `${results.sawa.length}S/${results.kalshi.length}K/${results.polymarket.length}P`,
  };
}

const QUERIES = ["Wu versus Djokovic", "Netherlands versus Monaco", "Netherlands vs Morocco to advance"];
const K = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const r0 = (n: number) => Math.round(n);

/** Clear ALL four caches so a COLD run is a true first-time turn (intent + clarify + market-id + feed). */
function clearAll(): void {
  __clearCache(); // pmxt market-id cache
  __clearFeedCache(); // Sawa public-feed cache
  __clearIntentCache(); // cold-start intent classification (Gemini)
  __clearClarifyCache(); // clarify-decision cache (Gemini)
}

/** COLD = clear all caches before each run; CACHED = warm once so the repeat turn hits every cache. */
async function measure(text: string, cached: boolean): Promise<Walk[]> {
  const runs: Walk[] = [];
  if (cached) {
    clearAll();
    await turn(text); // warm: caches the intent + clarify decisions (Gemini) AND market IDs + feed
  }
  for (let i = 0; i < K; i++) {
    if (!cached) clearAll();
    runs.push(await turn(text));
    await sleep(800);
  }
  return runs;
}

console.log(`# bench-flow — full iMessage turn, COLD vs CACHED, per-step — ${config.apiBaseUrl}\n`);
for (const text of QUERIES) {
  const cold = await measure(text, false);
  const warm = await measure(text, true);
  const f = cold[0]!;
  const m = (rs: Walk[], sel: (w: Walk) => number) => r0(med(rs.map(sel)));
  const dIntent = m(cold, (r) => r.intentMs) - m(warm, (r) => r.intentMs);
  const dResolve = m(cold, (r) => r.resolveMs) - m(warm, (r) => r.resolveMs);
  const dClarify = m(cold, (r) => r.clarifyMs) - m(warm, (r) => r.clarifyMs);
  const coldTot = m(cold, (r) => r.totalMs);
  const warmTot = m(warm, (r) => r.totalMs);
  const pctSaved = coldTot > 0 ? r0((1 - warmTot / coldTot) * 100) : 0;
  console.log(`QUERY: "${text}"   (DM → always handled; medians over ${K} runs each)`);
  console.log(`  step                          COLD     CACHED`);
  console.log(`  0. routing / mention-gate     ~0ms     ~0ms     (regex; DM always-handled)`);
  console.log(`  1. parseIntent                ${m(cold, (r) => r.intentMs)}ms     ${m(warm, (r) => r.intentMs)}ms     <- intent cache (via ${f.intentVia}; Gemini)`);
  console.log(`  2. runSearch (resolve+price)  ${m(cold, (r) => r.resolveMs)}ms     ${m(warm, (r) => r.resolveMs)}ms     <- market-id cache (matched ${f.venues})`);
  console.log(`  3. clarify decide (+Gemini)   ${m(cold, (r) => r.clarifyMs)}ms     ${m(warm, (r) => r.clarifyMs)}ms     <- clarify cache (Gemini)`);
  console.log(`  4. render reply               ${m(cold, (r) => r.renderMs)}ms     ${m(warm, (r) => r.renderMs)}ms`);
  console.log(`  ---------------------------------------------------`);
  console.log(`  TOTAL to reply-ready          ${coldTot}ms     ${warmTot}ms`);
  console.log(`  5. iMessage send (Spectrum)   ~constant platform hop (not measured)`);
  console.log(`  → CACHED removes: intent ~${dIntent}ms (Gemini) + clarify ~${dClarify}ms (Gemini) + resolve ~${dResolve}ms (market-id)`);
  console.log(`  → TOTAL time saved: ${coldTot}ms → ${warmTot}ms = ${pctSaved}% faster to reply-ready`);
  console.log(`  path: ${f.path}`);
  console.log(`  reply: ${JSON.stringify(f.body.slice(0, 160))}`);
  console.log(`  raw totals  cold: ${cold.map((r) => r0(r.totalMs))}   cached: ${warm.map((r) => r0(r.totalMs))}\n`);
}
