/**
 * bench-flow.ts — walk the ENTIRE iMessage turn for a bare matchup query (as-is, cold), timing every
 * step from "message received" to "reply ready to send". Mirrors index.ts runConversationalSearch:
 *   routing/gating → parseIntent → runSearch (resolve + price) → clarify decide(+LLM refine) → render.
 *
 * Bare matchups ("Wu versus Djokovic") have NO search-trigger word, so the regex gate is NOT confident
 * and parseIntent falls through to the Gemini LLM (unlike "odds on X", which the regex gate resolves in
 * ~0 ms). Caches are cleared before each run, so this is the true cold/first-time flow.
 *
 * Run:  npx tsx bench-flow.ts
 */
import "./src/env";
import { performance } from "node:perf_hooks";
import { getConfig, getPmxtConfig, getIntentConfig } from "./src/sawa/config";
import { runSearch, flattenRanked } from "./src/search";
import { parseIntent, refineClarify } from "./src/sawa/intent";
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

const QUERIES = ["Wu versus Djokovic", "Netherlands versus Monaco"];
const K = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const r0 = (n: number) => Math.round(n);

console.log(`# bench-flow — full iMessage turn, per-step, cold/as-is — ${config.apiBaseUrl}\n`);
for (const text of QUERIES) {
  const runs: Walk[] = [];
  for (let i = 0; i < K; i++) {
    __clearCache();
    __clearFeedCache(); // cold: a true first-time question
    runs.push(await turn(text));
    await sleep(800);
  }
  const f = runs[0]!;
  console.log(`QUERY: "${text}"   (DM → always handled; medians over ${K} cold runs)`);
  console.log(`  0. routing / mention-gate     ~0 ms   (regex; DM always-handled, idempotency Set)`);
  console.log(`  1. parseIntent                ${r0(med(runs.map((r) => r.intentMs)))} ms\t(via: ${f.intentVia}${f.intentVia === "llm" ? " — Gemini fired" : ""})`);
  console.log(`  2. runSearch (resolve+price)  ${r0(med(runs.map((r) => r.resolveMs)))} ms\t(matched ${f.venues})`);
  console.log(`  3. clarify decide (+LLM)      ${r0(med(runs.map((r) => r.clarifyMs)))} ms`);
  console.log(`  4. render reply               ${r0(med(runs.map((r) => r.renderMs)))} ms`);
  console.log(`  ----------------------------------------------------`);
  console.log(`  TOTAL to reply-ready          ${r0(med(runs.map((r) => r.totalMs)))} ms`);
  console.log(`  5. iMessage send (Spectrum)   ~constant (platform network — not measured here)`);
  console.log(`  path: ${f.path}`);
  console.log(`  reply: ${JSON.stringify(f.body.slice(0, 200))}`);
  console.log(`  raw totals ms: ${runs.map((r) => r0(r.totalMs))}\n`);
}
