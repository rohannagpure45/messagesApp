# Sawa in-chat prediction-market agent — plan (v4, authoritative)

> Supersedes v1–v3. Source of truth for what we're building and why. Companions:
> [`SPECTRUM_INTEGRATION.md`](SPECTRUM_INTEGRATION.md) (identifiers, inbound events incl. reactions,
> **outbound presentation toolkit**, analytics mapping), [`PMXT_INTEGRATION.md`](PMXT_INTEGRATION.md)
> (cross-venue enrichment), [`DATABASE_MAP.md`](DATABASE_MAP.md) (live Sawa schema). Grounded in
> first-hand investigation of the real Sawa web app (`../Sawa-app`) and `spectrum-ts@^4.2.0` types.
>
> **Status (2026-06-23):** **Part A DB/RLS is live; the `/api/bot/*` endpoints are MERGED but NOT yet
> deployed.** Sawa-app PR #26 (`feat/imessage-bot-api-and-rls`) and PR #27 (vitest harness + 56 bot-helper
> tests) are now **MERGED to `main`**. The DB changes (3 Prisma models + RLS deny-all on 41 tables) were
> applied **directly to Supabase** and are live. But **merged ≠ deployed**: the API routes are **not on
> Vercel/prod** — verified 23-Jun, `POST https://sawapredictions.com/api/bot/*` → **404**. The deploy is
> gated on the **repo owner's Sawa Vercel-org membership** (pending), so `main` hasn't been promoted to prod.
> §7 documents the contract Part B must conform to once those endpoints are deployed. Deploy to Vercel with
> `BOT_SECRET` / `BOT_HASH_SECRET` set before Create/betting/analytics.
>
> **Part B status:** **Phase 1 SEARCH is built** (messagesApp PR #2) and works **today** because it depends
> only on the public `GET /api/predictions*` read path (Option C, §6 — live, 200), holding **no** bot/DB
> credentials. CREATE (Fri 03-Jul YC milestone), betting, and analytics are the remaining build and are
> **blocked on the `/api/bot/*` deployment above**. Suggest deferred to Wk5. The master-credential risk
> (§10.1) stands and applies only to those future phases — SEARCH never touches `SAWA_BOT_SECRET`.

---

## 1. Product vision — Folk-style, but better

We are building a **live, conversational, richly-formatted in-chat prediction-market agent** named
(default) **`sawa`**, living in iMessage DMs + groups. Inspired by Folk's "Kalshi in iMessage," but
deliberately **better on two axes Folk is weak on**:

1. **UI/UX.** Folk replies in plain, unformatted text. We render **clean, card-based output** — native
   rich-link market cards (with cover image), tappable polls for one-tap betting, markdown odds/portfolio
   layouts, rendered odds-bar/chart images, and celebratory effects (confetti on a win). See §4.
2. **Depth.** You can **create, search, and stake on everything in Sawa** from the chat (§3), and we
   **pour in Kalshi/Polymarket-style data via pmxt** — cross-venue real-money price anchors, a
   "what's trending across prediction markets" feed that seeds one-tap Sawa market creation, and price
   history charts (§5). Betting itself stays on Sawa (virtual coins, real engine).

It trades real Sawa coins via the web app's authenticated API (per-user JWT) — reusing the real
time-weighted-parimutuel engine, ledger, odds, and notifications with **zero** reimplemented money logic.

| Folk moment (trailer) | Sawa, better | How |
|---|---|---|
| Plain-text odds reply | **Rich market card** (richlink cover + markdown odds + tap-to-bet poll) | §4 presentation layer |
| "folk odds it will rain" → creates a market | **NL create**, previewed as a card before confirm | reuse `../Sawa-app/lib/ai/generate-prediction.ts` → `POST /api/predictions` (user JWT) |
| "100$ on YES" → text quote → "yup" | **Quote card → tap 👍 or "yup" → confetti on placement** | `POST /api/predictions/[id]/bet` + `effect` |
| (none) | **"what's trending across Kalshi/Polymarket" → one-tap create on Sawa** | pmxt `/v0/markets` (§5) |
| (none) | **cross-venue price anchor on a Sawa market** ("Kalshi 62¢") | pmxt `fetchMatchedMarketClusters` |
| 👍 tapback | **reaction monitoring** → engagement + one-tap confirm | inbound `message.reactionAdded` |

Interaction model: mention + natural language is **primary** (`sawa …` / `@sawa`); slash commands are a
power-user fallback; polls + tapbacks are tap affordances; the agent has a configurable persona/voice.

---

## 2. Decision log (locked with the user)

1. **Go LIVE via JWT→API.** Real Sawa coins, real engine; **no sandbox.** Reuse the bet/create/resolve
   API with a per-user JWT.
2. **Reuse the engine; never recompute payouts** (time-weighted parimutuel; odds are display-only).
3. **Provision via `POST /api/bot/session`** in `../Sawa-app` (`BOT_SECRET`-guarded) — **SHIPPED.** Mints a
   7-day HS256 user JWT (`{userId}`) for the handle; full request/response contract in §7.
4. **Identity = phone**, merged with WhatsApp ghost users; group members via `sender.id` (phone or email).
5. **Intent model = Gemini Flash-Lite** via the OpenAI-compatible SDK (model/baseURL env-overridable).
6. **Rich UI is a first-class goal** (§4) — we explicitly out-design Folk's plain text.
7. **Full Sawa surface in chat** — create, search/trending, detail+odds, stake, portfolio, leaderboard,
   my-markets, resolve, share, watchlist (§3).
8. **pmxt cross-venue enrichment is IN scope** (§5): price anchors, trending-discovery→create, price
   charts. GET-only, free tier. Real-money cross-venue *trading* stays out (needs crypto wallets).
9. **Suggestions = real-time, in-conversation, reply-driven** (no cron/cold pushes — no "app opened"
   event exists; relevance comes from responding while the topic is hot).
10. **Reactions (tapbacks) are first-class** for engagement + analytics.
11. **Analytics privacy = max-privacy at rest** (HMAC-hashed handles+spaceId, no bodies, RLS-deny).
12. **Read-only invariant retired** → "writes only via the authenticated API / bot endpoints."
13. **Two separate repos (recommended, pending ratification).** Keep the bot (`messagesApp`) out of the
    `Sawa-app` monolith. The repo boundary makes the no-direct-DB-write invariant *structural* (the bot has
    no Prisma/Supabase client — it physically can't touch Postgres except over HTTP); it matches the runtime
    split (always-on daemon vs Vercel serverless); and it keeps `BOT_SECRET` (a master credential — §10.1)
    out of the money app's blast radius. The one real cost — contract drift on the 3 endpoints — is cheaply
    mitigated by a shared `contract.ts` (the zod types already in `../Sawa-app/lib/bot/vocab.ts`) + one
    contract test. A pnpm/turbo workspace gets shared types *and* separate deploy but restructures the
    production app for marginal gain — not now.
14. **Discovery reads move to the app's public GET endpoints — RESOLVED: Option C.** Part A's RLS deny-all
    (all 41 tables) killed the anon-key read path. The fix is **Part B-only, no new Part A work**: repoint
    `src/sawa/read.ts` from Supabase PostgREST to the **already-public** `GET /api/predictions`,
    `GET /api/predictions/[id]`, `GET /api/predictions/[id]/odds`, `GET /api/predictions/trending` (no JWT;
    they enforce the private-market guard server-side) and **drop `SAWA_SUPABASE_*` from the bot entirely**.
    (Option B — scoped anon RLS policy — rejected: needs new Part A SQL + keeps a DB key in the bot.)

---

## 3. Capabilities — the Sawa surface in chat

Available by NL ("sawa …"), slash, or tap. Each maps to an existing Sawa API/read path — **no new
betting/create endpoints**; reuse the app's. Deliberately scoped into a tight **v1 core loop** and
**v1.1+ extensions** (not all-at-once).

**Money-action invariant (every stake / create / resolve):** the bot NEVER executes a coin action
without an explicit, unambiguous confirm that names the market + amount, and it **dedupes on the
confirming message's `id`** (inbound is at-least-once → a redelivered confirm must not double-bet). A
poll tap or 👍 tapback is **intent pre-fill only** — it routes into validate→quote→confirm, never a
direct `placeBet` (§4).

### v1 core
| Capability | Trigger | Backend | Output |
|---|---|---|---|
| **Search / discover** | "sawa find <topic>" · `/markets` `/search` | GET read path (`src/sawa/read.ts`) | mini market cards |
| **Market detail + odds** | "sawa odds <market>" · `/show` `/odds` | GET detail + latest `OddsSnapshot` | rich card: richlink + odds bars (+ pmxt anchor, §5) |
| **Stake / bet** | "100 on YES" · `/bet` | `POST /api/predictions/[id]/bet` (JWT) | confirm card → place → confetti |
| **Balance** | "my balance" · `/balance` | `GET /api/user/stats` (JWT) | balance card (**DM-only in groups**, §9) |
| **Create a market (NL)** | "sawa make a market on <topic>" · `/create` | `generate-prediction` → `POST /api/predictions` (JWT) | drafted-market card → confirm |

> **Search has no server-side text API.** `GET /api/predictions` exposes no `?search=` and there is no
> `/predictions/search`, so Sawa-side search is **client-side matching** over the (small) open-market feed for
> v1; cross-venue results come from pmxt (§5). A `?search=` param is an optional scale follow-up, not a YC
> milestone dependency. See `BUILD_PLAN.md` §4.

### v1.1+ (sequence after the core loop)
Portfolio/positions, leaderboard, my-created-markets, share, watchlist, **resolve (creator)**, price
charts, and **pmxt trending→create**. Notes: `GET /api/predictions/history` returns **resolved bets
only** — "my open positions" needs an added read (PostgREST `Bet` by `userId` where
`prediction.resolved=false`, or a new Part-A filter). Resolve is destructive → gate behind explicit
multi-step confirm. Charts need a real renderer (§4).

**Stake quote — honest about payout.** The bet API returns only `{success:true}`; there is **no
dry-run/quote endpoint**, and recomputing payout client-side would violate decision #2 (time-weighted
parimutuel + early-bird + creator stake → any client estimate is wrong). So the confirm card shows
**current odds + stake + live `maxBetAmount` + balance check**, and states **payout is decided at
resolution** — not a projected return. (A true projected-payout quote = a new Part-A endpoint; see §7.)

Guardrails reused server-side: `bettingEnabled`/`predictionsEnabled` kill-switches; **live
`maxBetAmount` — currently 100, read from `PlatformSettings`, do NOT assume the schema default 10000**;
terms acceptance — **wire in-chat consent through `POST /api/bot/session`'s `acceptTerms: true` flag**, which
sets `termsAcceptedAt` directly (no separate `POST /api/user/terms` round-trip needed on the bot path; the
session response's `termsAccepted`/`created` fields drive first-time-consent UX); deadline/resolved checks;
`freeTierCreateLimit`; rate limits. The bot maps typed API errors to friendly in-voice replies.

---

## 4. Presentation / UI — "better than Folk" (the rich toolkit)

> Outbound content builders verified first-hand in `node_modules/spectrum-ts/dist/authoring-b9AhXgPI.d.ts`
> + `providers/imessage/index.d.ts`. Full detail in `SPECTRUM_INTEGRATION.md` §4.

A small **presentation layer** (`src/sawa/cards.ts`) turns domain objects into clean rich content. The
visual language per surface:

- **Market card** = `richlink(marketUrl)` (native preview bubble: cover + title + summary, pulled lazily
  from the market page's OG tags — the Sawa app already emits these for public markets) **+** a `markdown`
  odds line **+** (optionally) a `poll` of the options. **Safety/fallbacks:** richlink accessors fail
  silently to `undefined` (no retries) → if `cover()`/`title()` come back empty, fall back to a plain
  `markdown` card; and **never richlink a `isPrivate`/`isHidden` market** (its OG image/title would leak to
  the whole space — use markdown, no link). The `poll` is a **tap-to-bet *intent*** (carries no amount and
  no poll id) → a tap pre-fills market+option and routes into validate→quote→confirm; it is **never** a
  direct bet (see §3 invariant + `SPECTRUM_INTEGRATION.md` poll caveats).
- **Odds / detail** = `markdown` percentage bars (e.g. `Yes ▰▰▰▰▰▰▰░░░ 70%`) + optional pmxt price anchor.
- **Quote / confirm** = a compact `markdown` card showing **current odds + stake + live max-bet +
  balance** (NOT a projected payout — the engine exposes none; §3). Accept via typed "yup"; a 👍 tapback
  may advance the confirm **only** once `space.send` id ↔ tapback `target.id` correlation is
  runtime-verified, the action is idempotent + time-boxed, and the card unambiguously names market +
  amount — otherwise require typed confirmation.
- **Bet placed / you won** = confirmation `markdown`, then a celebratory `effect`
  (`confetti`/`fireworks`) as a **separate** message — `effect` wraps only `text`/`markdown`/`attachment`
  content (not richlink/poll), so don't wrap it around a rich card.
- **Portfolio / leaderboard** = clean `markdown` tables/lists (bold, ranks, P/L coloring via emoji).
- **"Thinking"** = `streamText`/`text(stream)` so the agent streams its reply (iMessage edits the bubble
  in place) instead of a dead pause.
- **Rendered image cards (phase 2 enhancement)** = generate an odds-bar / market-card / chart PNG and
  send as an `attachment` for the cleanest custom visuals (render via SVG→PNG in-process, or reuse the
  app's image stack). Start with richlink+markdown+poll; add rendered images once the loop works.
- **Native mini-app cards (future ceiling)** = `customized-mini-app` (iMessage `MSMessageTemplateLayout`)
  is the richest interactive bubble but **requires a real iMessage app extension** (`teamId`,
  `extensionBundleId`, App Store entry). Out of v1; the path to the most app-like UI later.

Consistency rules: every coin/market message keeps the virtual-coin disclaimer; persona/voice is a thin
LLM-generated wrapper around **deterministic** facts (odds, quotes, results), guard-railed (length cap,
no harassment, never drops the disclaimer).

---

## 5. Cross-venue enrichment via pmxt (the "Kalshi features")

> Full reference + endpoints/schema/limits in [`PMXT_INTEGRATION.md`](PMXT_INTEGRATION.md).

pmxt (`api.pmxt.dev`, free tier 25k credits/mo, GET-only, `Authorization: Bearer pmxt_live_…`) is a
unified API over 13+ venues incl. **Kalshi & Polymarket**. Sawa is *not* a pmxt venue, so pmxt never
sources or settles Sawa bets — it **enriches and seeds**. Three v1 uses (all read-only, `src/pmxt/`):

1. **Cross-venue price anchor.** On a Sawa market reply, `fetchMatchedMarketClusters` (anchored by the
   market title, thresholded by `minConfidence`) → "📊 Kalshi 62¢ · Polymarket 60¢" beside Sawa's
   virtual odds. A real-money reality check no Sawa-only bot has. Always label external prices as
   real-money venues vs Sawa virtual coins.
2. **Trending discovery → create on Sawa (draft, not one-tap).** `GET /v0/markets?category=…&limit`
   (sorted by 24h volume) → "🔥 trending" cards; each offers **"create on Sawa?"** → the NL create flow,
   shown as a **drafted-market card with an explicit confirm** (never one-tap — create charges the
   requesting user a `creatorStakeAmount` on first bet, ~`creatorLiquidityPct`). Specify: the
   **creator/host = the requesting user** (their JWT), they bear the creator stake, and the bot
   **dedupes against existing Sawa titles** first to avoid near-duplicate floods. This scales "trade on
   anything" past Sawa's current ~78 markets.
3. **Price history charts** *(v1.1+)*. `fetch_ohlcv` for a matched market → rendered chart image
   attachment — gated on having an actual image renderer (§4).

Discipline: GET-only client mirroring `src/sawa/http.ts`; **never** import the trade host
(`trade.pmxt.dev`, EIP-712 + USDC escrow); never pass Sawa user identifiers to pmxt; new secret
`PMXT_API_KEY`. Enrichment is **fail-soft** (a pmxt error/timeout never blocks a Sawa reply).
`fetchMatchedMarketClusters` is embedding+LLM-backed and may cost **more than 1 credit** — **cache per
market with a TTL and gate per space** (don't call it on every group message); confirm its credit cost
before leaning on the free tier. Betting and balances remain 100% Sawa.

---

## 6. Architecture (two repos)

```
iMessage user ─► Spectrum cloud ─► [Part B] sawagc bot (this repo, in-process Node daemon)
   provision + JWT   ─► [Part A] Sawa-app  POST /api/bot/session                 (Bearer BOT_SECRET)
   analytics + state ─► [Part A] Sawa-app  POST /api/bot/events, POST /api/bot/state
   bet/create/reads  ─► [Part A] Sawa-app  POST /api/predictions[...], GET /api/user/stats, ...  (user JWT)
   discovery reads   ─► [Part A] Sawa-app  public-markets read endpoint (see read-path note below)
   cross-venue (GET) ─► pmxt  api.pmxt.dev/v0/markets, clusters, ohlcv          (Bearer pmxt_live_)
```

Bot never writes (or, post-RLS, reads) the DB directly; everything goes over HTTPS to the web app behind
`BOT_SECRET` or a per-user JWT, plus pmxt as a separate GET-only enrichment client. In-process single Node
daemon (validated for ~5 concurrent; no broker/Redis/K8s).

**Read-path note — RESOLVED: Option C (decision §2.14).** Part A's RLS deny-all (all 41 tables) means the
anon role sees **0 rows**, so the original direct-PostgREST path (`src/sawa/read.ts`) is broken. **Fix is
Part B-only — no new Part A work:** the app already exposes the reads the bot needs, **public, no JWT**, with
the private-market guard enforced server-side (verified in `../Sawa-app` 2026-06-22):
- `GET /api/predictions` — public feed; per-option pool `volume` = live odds; `?page`/`limit` params.
- `GET /api/predictions/[id]` — detail; 401 `needsAccess` **only** for private markets.
- `GET /api/predictions/[id]/odds` — pool sums per option; auth required only when the market is private.
- `GET /api/predictions/trending` — public ranked feed.

Repoint `read.ts` to these (compute display odds from `volume`/pool sums; filter `resolved=false`
client-side) and **drop `SAWA_SUPABASE_*` from the bot entirely** → the bot then holds **no** DB credentials,
only `BOT_SECRET` + a per-user JWT, making the no-direct-DB invariant absolute. *(Rejected: **B** scoped anon
RLS policy — new Part A SQL + keeps a DB key in the bot; **A** service_role key — god-credential.)*

---

## 7. Part A — Sawa-app bot surface (SHIPPED, separate repo)

**Shipped** in `../Sawa-app` (branch `feat/imessage-bot-api-and-rls`, PR #26; re-verified against the repo
2026-06-22). This is the contract Part B must conform to — not work to be done. All three endpoints are
**POST + JSON body**, gated on **`Authorization: Bearer <BOT_SECRET>`** (constant-time compare; case-sensitive
`Bearer ` prefix, token byte-length must equal the secret; 401 `{error:"Unauthorized"}` on any failure incl.
unset `BOT_SECRET`). Shared validation/hashing lives in `lib/bot/{guard,hash,vocab}.ts` (56 passing tests).

**`POST /api/bot/session`** — mint a per-user JWT.
- Req `{ handle (req, non-empty), handleKind?: "phone"|"email", acceptTerms?: boolean (only literal true accepts), displayName?: any (accepted, NOT stored) }`.
- Res 200 `{ token, userId, username, balance, termsAccepted, created }` (`created=true` ⇒ a new ghost user was minted for the handle).
- Errors 400 `Invalid request body` / `handle is required` / `Invalid handleKind` / `Invalid handle` (phone `^\+[1-9]\d{6,14}$` or email regex); 500 `Something went wrong`.
- JWT = **HS256, payload `{userId}` only, 7-day expiry** (route passes no `rememberMe`); invalidated early by `passwordChangedAt` / block-status. Idempotent per handle for user creation; **not replay-protected** — don't blindly retry on timeout (token issuance + `acceptTerms` recur).

**`POST /api/bot/events`** — analytics ingest (batch).
- Req `{ events: BotEventIn[] }`, array, **≤200/batch** (>200 → 400). `BotEventIn` **required**: `eventGuid`, `platform` (must be `"imessage"`, lowercase), `eventType` (closed set of 9), `spaceId` (RAW), `occurredAt` (parseable date string). Optional: `handle`+`handleKind` (RAW), `spaceType`∈{dm,group}, `contentType`∈8, `intent` (slug `^[a-z0-9_.-]{1,64}$`), `predictionId`, `targetGuid`, `meta` (clampMeta-whitelisted, §9). `linePhone` accepted but not stored.
- Res **always 200** if the batch is well-formed: `{ received, inserted, deduped, rejected, errors:[{index,eventGuid?,reason}] }`. **Partial success — inspect the counts, not just status.** Dedup = P2002 on `eventGuid` → counted in `deduped` (not `rejected`); **whole batches are safe to retry.**
- Server normalizes + **HMAC-SHA256-hashes** handle/spaceId with `BOT_HASH_SECRET` (the bot never holds it), resolves `userId` (batched `findMany`; events never *create* users), persists **only hashes**. Fresh-insert-only best-effort rollups: `BotActorState` (lastInbound/lastSuggested), `suggestion_sent`+predictionId → `BotSuggestion` upsert `(spaceIdHash,predictionId)`, `reaction_in`+targetGuid → `BotSuggestion.engaged=true` where `sentMessageId=targetGuid`.

**`POST /api/bot/state`** — re-suggest / opt-out read (**POST, not GET**, deliberately, to keep raw phone/email out of URLs + access logs).
- Req `{ handle?, spaceId?, handleKind? }` — **≥1 of handle/spaceId required** (else 400 `handle or spaceId is required`); malformed handle → 400 `Invalid handle`. Res 200 `{ optedOut, lastSuggestedAt: string|null (ISO), suggestedPredictionIds: string[] }`. Pure read; never creates a user.

**Models** (`prisma/schema.prisma`, all `id String @id @default(uuid())` — **uuid, not cuid**): `BotEvent`
(`eventGuid @unique` — the real dedup key, not `id`), `BotSuggestion` (`@@unique([spaceIdHash, predictionId])`),
`BotActorState` (`senderHandleHash @unique`). `meta` is hard-limited by `clampMeta` (§9).

**DB / RLS posture.** RLS is **ENABLED (not FORCEd), zero policies → deny-all** for anon/authenticated;
`postgres` (Prisma via `DATABASE_URL`) + `service_role` bypass it, so app writes are unaffected. Scope:
**41/41 public tables** (the 3 new + 38 existing), verified live. DDL is mirrored in version control at
`../Sawa-app/supabase/migrations/` (commit `e7ace0f`): `*_bot_analytics_tables.sql`,
`*_enable_rls_existing_tables.sql`, `README.md`. **Apply path = raw SQL via Supabase `apply_migration` +
`prisma generate` (client only) — never `prisma migrate dev` / `db push` against prod** (no migration
history; either would offer to reset). Those `.sql` files are reproducibility mirrors — prod is already at
this state; do not re-run. ⚠️ This deny-all is what breaks the bot's anon reads (§6 read-path note).

**Remaining Part A work — minimal (the read path needs nothing):** (1) ~~discovery-read endpoint~~ **not
needed — Option C reuses the existing public `GET /api/predictions[...]` routes** (§6); (2) verify market
pages emit good **OG tags** (`og:image`/title/description) for richlink cards; (3) *(fast-follow, not a
blocker)* **rate-limit `POST /api/bot/session`** to blunt the master-credential risk (§10.1); (4) a true
projected-payout quote endpoint is still absent (§3) — out of v1. **Env (server-only, in `../Sawa-app`):** `BOT_SECRET`
(auth), `BOT_HASH_SECRET` (HMAC hashing — **the bot never holds it**; rotating it orphans all stored hashes),
`JWT_SECRET` (signs the user JWT; independent of both `BOT_*`).

---

## 8. Part B — the bot (this repo)

- **Config/HTTP/identity:** extend `src/sawa/config.ts` (`apiBaseUrl`, `botSecret`, `INTENT_LLM_*`,
  `botName`, `marketUrlTemplate`, `PMXT_API_KEY`, `SUGGEST_COOLDOWN`); add `postJson` to `src/sawa/http.ts`;
  `src/sawa/api.ts` — live client **conforming to §7** (every call POST+JSON with `Bearer BOT_SECRET`;
  `getBotState({handle, spaceId})` is **POST**; `/events` chunked **≤200** with **partial-success** handling;
  sends **RAW** handle/spaceId — never hashes; `platform:"imessage"` lowercased; `intent` slugified; typed-error
  mapping); `src/sawa/session.ts` (senderId→JWT cache, **TTL ≤7d**, re-mint on rotation; consent via the
  session `acceptTerms` flag).
- **Conversational core:** `src/sawa/intent.ts` (Gemini Flash-Lite, JSON mode, market-list injection,
  clamp/re-verify, regex-first gate); `src/sawa/reply.ts` (persona/voice + disclaimer + safety clamps);
  `src/sawa/bets.ts` (validate→quote→confirm→`executeBet`, sole `placeBet` caller); `src/sawa/create.ts`
  (NL→draft→confirm→create).
- **Presentation:** `src/sawa/cards.ts` (richlink/markdown/poll/effect/attachment builders per §4).
- **Enrichment:** `src/pmxt/http.ts` (GET-only) + `src/pmxt/discover.ts` (markets, clusters, ohlcv).
- **Router (`src/index.ts`):** handle `text`, `poll_option`, `reaction` inbound; group mention-gating;
  route NL → intent → capability (§3); reply with rich cards; emit analytics + reaction engagement.
- **Tests/docs/deps:** rescope `tests/read-only.test.ts` to the discovery read path; extend the static
  GET-only scan to `src/pmxt`; add `api`/`bets`/`intent`/`cards` tests; add `openai` dep; update
  `.env.example` + `AGENTS.md`.

---

## 9. Privacy / consent
**At rest:** the bot sends **RAW** handle/spaceId; the **server** HMAC-SHA256-hashes them (`BOT_HASH_SECRET`,
which the bot never holds), resolves `userId`, and stores **only hashes** — never raw handles/spaceIds/message
bodies. `meta` is hard-whitelisted by `clampMeta`: numbers `{rank,score,latencyMs,tokenCount,oddsBps,stake}`
+ strings `{source,batchId,sentMessageId,command,outcome}` (≤64 chars, ≤12 keys); **everything else (incl.
`emoji`, `optionLabel`, `amount`, free text, nested objects/arrays) is silently dropped** — so e.g. a bet's
amount must ride in `meta.stake`, not `meta.amount`. RLS is **deny-all on all 41 tables** (not just the 3
new ones); in groups log only the interacting actor; pmxt receives **no** user identifiers (market
title/category only). **In-chat / outbound:** one-time consent before the first money action, **wired via
`/api/bot/session`'s `acceptTerms` flag** (sets `termsAcceptedAt` so the first bet doesn't 403 — no separate
`/api/user/terms` call); durable `optedOut` (checked via `POST /api/bot/state`); **balance / portfolio / position replies in a group go DM-only or are redacted** (never expose
a member's wallet to the space); **never richlink a `isPrivate`/`isHidden` market** (OG leak). Virtual-coin
disclaimer on every coin/market message.

## 10. Risks / must-verify
1. **`BOT_SECRET` is a master credential (critical):** `POST /api/bot/session` mints a valid 7-day user JWT
   for **any** handle resolvable by phone/email — incl. funded, non-ghost real accounts (no `isGhost` check,
   no bot-only scope, no per-handle binding); the token is indistinguishable from a normal login and works
   for all money actions (only block-status + password-rotation remain as defenses). The route has **no rate
   limiting / replay protection.** ⇒ Treat `SAWA_BOT_SECRET` as the highest-value secret; never log/echo it;
   scope it tightly in the bot's deploy env (reinforces the separate-repo decision §2.13); consider
   abuse-rate-limiting `/session` on the Sawa-app side.
2. **Anon discovery reads broken by Part A RLS (critical):** deny-all on all 41 tables ⇒ the direct
   PostgREST path returns empty under the anon key — resolve per §6 read-path note before Part B reads.
3. **Idempotent money actions (critical):** at-least-once delivery → a redelivered confirm must not
   double-bet — guard `placeBet`/create/resolve on the confirming message's `id` before executing.
4. `sender.id` phone-vs-email rate (email → distinct identity). 5. **Live `maxBetAmount`=100** (not the
   schema default 10000) — read `PlatformSettings`; keep examples ≤ the live cap. 6. **Consent→terms:**
   first bet 403s unless `termsAcceptedAt` is set — wire consent to `/api/bot/session`'s `acceptTerms` flag.
   7. richlink depends on market-page OG tags + fails silently → verify OG (Part A) and define the markdown
   fallback. 8. `space.send()` id == tapback `target.id` (gates reaction-confirm AND engagement) — prove
   before trusting. 9. pmxt match-cluster quality — threshold `minConfidence`; cluster credit cost — cache +
   per-space gate. 10. webhook at-least-once → dedupe on `message.id`. 11. LLM banter safety — clamp; keep
   disclaimer. 12. `effect` wraps only text/markdown/attachment; `effect`/`attachment` support varies —
   degrade gracefully. 13. group interjection cooldown keyed on `spaceId`.

## 11. Build order & verification
> **Progress (23-Jun):** **SEARCH is built** — steps (2 reads/Option C), (4 presentation), and (8 pmxt
> enrichment) below are DONE for the discovery path (messagesApp PR #2): `read.ts` (Option C), `src/pmxt/*`,
> `src/search.ts`, `src/sawa/cards.ts`, `src/sawa/intent.ts`, mention-gated router. Steps (3 betting),
> (5 create), (6 portfolio), (7 analytics) are **untouched** and gated on the `/api/bot/*` deployment.

**Order:** (1) ~~Part A models + RLS~~ **DB/RLS DONE (live in Supabase).** Endpoints coded in PR #26 but
**OPEN/not deployed** (`/api/bot/*` → 404) — **merge + deploy #26/#27 before steps 3/5/7.** Remaining Part A:
**verify OG tags** (+ optional `/session` rate-limit). (2) Bot config/http/`api.ts` (conform to §7) + **`read.ts` → app public
(+ optional `/session` rate-limit). (2) Bot config/http/`api.ts` (conform to §7) + **`read.ts` → app public
GET endpoints (§6 Option C)** + session cache + **identity probe**. (3) NL betting (quote→confirm→execute) on existing markets — core loop. (4) **Presentation
layer** (rich cards) applied to discovery/odds/bet. (5) NL market creation. (6) portfolio/balance/leaderboard
+ voice. (7) Analytics + reactions + reply-driven relevance. (8) **pmxt enrichment** (price anchor →
trending→create → charts). (9) Rescope tests; finish docs.
**Verify:** `npm run typecheck` + `npm test`; **client-conformance curls against the shipped Part A** (session
mints a JWT; `/events` dedupes on `eventGuid` + returns partial-success counts; `/state` POST honors
opt-out/already-suggested) — Part A's own 56-test vitest suite already locks the server invariants. Then
terminal dev for each capability in §3; rich cards render in a real iMessage chat (richlink cover, poll tap,
confetti); **live proof** (one small real bet → real `Bet`/`Transaction`/`User.balance` changed in the web
app); pmxt anchor + trending-create flow; typed-error → friendly replies.

## 12. Out of scope / future
Real-money **cross-venue trading** (pmxt `trade.pmxt.dev`, needs crypto wallets — never); native
**iMessage mini-app extension** (richest UI ceiling); scheduled re-engagement digest (ToS/consent);
Telegram/WhatsApp providers.
