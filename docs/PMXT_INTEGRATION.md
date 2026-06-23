# pmxt cross-venue enrichment reference

> How the bot "pours in Kalshi/Polymarket features" without becoming a real-money broker. pmxt is a
> **read-only enrichment + discovery layer** beside Sawa's own catalog — it never sources, prices, or
> settles a Sawa bet. Researched 2026-06-20 against pmxt.dev docs. Companion to
> [`BETTING_BOT_PLAN.md`](BETTING_BOT_PLAN.md) §5.

## 1. What pmxt is
A unified API/SDK over **13+ prediction-market venues** (Polymarket, **Kalshi**, Limitless, Smarkets,
Probable, Myriad, Opinion, …). REST base `https://api.pmxt.dev`; TS package `pmxtjs`; an MCP server. One
bearer key. **Sawa is not a pmxt venue** (it's a private Supabase app with no public feed), so pmxt is
strictly complementary — Sawa remains the only source/engine for Sawa markets and bets.

## 2. Auth, limits, cost
- `Authorization: Bearer pmxt_live_…` (or `X-Api-Key`). Key from pmxt.dev dashboard → `PMXT_API_KEY` in `.env`.
- **Free tier: 25,000 credits/mo, 60 req/min, 5 WS streams, $0.** (1 REST call = 1 credit.) Over-limit → `429`.
- Two hosts: **`api.pmxt.dev`** = reads/catalog/clusters (bearer only, **no wallet**) — the only host we use.
  **`trade.pmxt.dev`** = writes, requires EIP-712 signature + USDC escrow — **never imported.**
- Catalog reads are fast (~10ms p95, warm Postgres catalog).

## 3. Read endpoints we use (GET, bearer only)
- **`GET /v0/markets`** — params: `query` (full-text ILIKE on title/slug), `category` (exact), `exchange`
  (e.g. `kalshi`,`polymarket`), `closed` (bool), `limit` (≤500, default 50), `offset`. Sorted by 24h
  volume (no relevance/trending engine — ranking is inherent). → trending/discovery feed.
- **`GET /v0/events`** — same shape at the event level.
- **`fetchMatchedMarketClusters`** — semantically-equivalent markets across venues (embedding + LLM).
  Params: anchor (`marketId`/`slug`/`url`/`query`), `relation` (identity/subset/superset/overlap/disjoint),
  `minConfidence`, `venues`, `minVenues`, `sort` (volume|confidence), `limit`, `offset`. → cross-venue
  **price anchor** for a Sawa market. **Threshold `minConfidence`** before display (mismatch risk).
- **`fetch_ohlcv`** (+ `fetch_order_book`, `fetch_trades`) — price history → rendered chart attachment.

### UnifiedMarket schema (key fields)
`marketId`, `title`, `slug`, `description`, `url`, `image`, `category`, `tags[]`, `volume`, `volume24h`,
`liquidity`, `resolutionDate`, `status`, `outcomes[] {outcomeId,label,price}`. `null` always means "venue
has no value," never "pmxt failed."

## 4. The three v1 uses
1. **Cross-venue price anchor** on a Sawa market reply — `fetchMatchedMarketClusters(query=title, minConfidence)`
   → "📊 Kalshi 62¢ · Polymarket 60¢" beside Sawa's virtual odds (label clearly as external real-money).
2. **Trending → create on Sawa (draft, not one-tap)** — `/v0/markets?category=…&limit` → "🔥 trending"
   cards, each "create on Sawa?" → the NL create flow shown as a **drafted-market card with an explicit
   confirm** (`POST /api/predictions` via the **requesting user's** JWT — that user becomes creator and
   bears the `creatorStakeAmount`). **Dedupe against existing Sawa titles** before creating. Scales "trade
   on anything" past Sawa's current catalog.
3. **Price-history charts** *(v1.1+)* — `fetch_ohlcv` on a matched market → chart image attachment, gated
   on an actual image renderer.

## 5. Discipline / guardrails
- GET-only client `src/pmxt/http.ts` mirroring `src/sawa/http.ts`; extend `tests/read-only.test.ts`'s
  static scan to cover `src/pmxt` (the trade host must never appear).
- **Never** pass Sawa user identifiers to pmxt (query by market title/category only) — preserves no-PII.
- Enrichment is **fail-soft**: a pmxt timeout/error must never block or break a Sawa reply.
- **Cost control:** `fetchMatchedMarketClusters` is embedding+LLM-backed and may cost **more than 1
  credit** — cache per market with a TTL and gate per space (don't call it on every group message);
  confirm its real credit cost before relying on the 25k/mo free tier.
- Always label external prices as **real-money venues** to avoid conflating them with Sawa virtual coins.

## 6. Module sketch
`src/pmxt/http.ts` (GET, bearer, timeout/UpstreamError) · `src/pmxt/discover.ts`
(`fetchMarkets({query,category,exchange,limit})`, `fetchMatchedClusters({query,minConfidence,minVenues})`,
`fetchOhlcv(marketId)`) · wired into the router as the price-anchor enrichment + a "trending" capability,
leaving `src/sawa/read.ts`/`suggest.ts` as the authoritative source for Sawa's own markets.

## 7. Out of scope
Real-money trading on any venue (`trade.pmxt.dev`); treating pmxt as a Sawa-market source; personalization
(pmxt has no "for you" engine — that stays Sawa-side).
