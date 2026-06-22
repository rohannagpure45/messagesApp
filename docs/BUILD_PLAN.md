# Sawa in-chat agent — BUILD PLAN (execution roadmap to the YC milestone)

> **What this is.** The phased, dated execution plan for shipping the Sawa iMessage agent. It is the
> WHEN/HOW companion to the WHAT/WHY docs:
> - [`BETTING_BOT_PLAN.md`](BETTING_BOT_PLAN.md) — authoritative product + architecture (capabilities, money-action invariants, API contract §7).
> - [`SPECTRUM_INTEGRATION.md`](SPECTRUM_INTEGRATION.md) — the iMessage/Spectrum contract (identifiers, the 3 inbound events, presentation toolkit).
> - [`PMXT_INTEGRATION.md`](PMXT_INTEGRATION.md) — cross-venue (Kalshi/Polymarket) read enrichment.
> - [`DATABASE_MAP.md`](DATABASE_MAP.md) — live Sawa schema.
> - The **live first-steps checklist** lives in `~/.claude/plans/continue-tender-patterson.md` (mirror of §3–§4 here).
>
> **Hard deadline (YC application):** Search **and** Create both DONE by **Fri 03-Jul-2026**. These two flows
> *are* the YC application. Everything is sequenced to hit this. **Today: Mon 22-Jun-2026.**
>
> **Definition of DONE (every flow):** merged to `main` + running live in a real test group + demo recorded +
> feedback logged. Code that only passes tests is not done.

---

## 0. Where we are (ground truth, 22-Jun) — read before planning

- **Part A (Sawa-app) is shipped.** `/api/bot/{session,events,state}` + 3 Prisma models + RLS deny-all on all
  41 tables (PR #26). The bot-helper **validator tests are PR #27** (`test/imessage-bot-helpers`) — merge it;
  it locks `guard`/`hash`/`vocab`/`identity`. PR #27 adds **no** endpoints.
- **Read path is decided — Option C.** The bot reads Sawa through the app's **already-public** `GET
  /api/predictions`, `/api/predictions/[id]`, `/api/predictions/[id]/odds`, `/api/predictions/trending`
  (no JWT, PII-safe). **No further Part A work is needed for Search.** (Plan §6 / §2.14.)
- **The bot today is a slash-command, read-only discovery bot.** `src/index.ts` handles only `text` + the
  slashes `/markets /search /show /create(stub) /suggest(demo)`. The read path **was** broken by Part A's RLS
  deny-all (it used Supabase PostgREST); **task 0.6 repointed it to the app's public `GET /api/predictions*`
  (Option C) — DONE 22-Jun**, so reads work again and the bot holds no DB credentials.
- **Three realities that shape this build:**
  1. **No Sawa text-search API.** `GET /api/predictions` takes `page/limit/category` but **no `?search=`** and
     there is no `/predictions/search`. → Search's Sawa side does **client-side matching** over the (small,
     ~78) open-market feed for v1. A `?search=` param is an optional scale follow-up (small Part A task),
     **not** a YC-milestone dependency.
  2. **The live iMessage connection is unproven.** Biggest unknown → it's the Day-1 gate (§3.2).
  3. **`POST /api/bot/session` is a master credential** (mints a 7-day JWT for any handle, incl. funded
     accounts; no rate-limit/replay). Operational hardening runs in parallel on the Sawa-app side; **not** a
     blocker (BETTING_BOT_PLAN §10.1).

---

## 1. Timeline

| Week | Dates | Phase | Ship gate |
|---|---|---|---|
| — | Sun 21-Jun | Kickoff | — |
| Wk1 | **Mon 22 – Tue 23-Jun** | **Phase 0** — Setup & Foundations (de-risk) | iMessage proven; skeleton runs |
| Wk1 | **Wed 24 – Fri 26-Jun** | **Phase 1 — SEARCH** | **Search DONE, Fri 26-Jun** |
| Wk2 | **Mon 29-Jun – Fri 03-Jul** | **Phase 2 — CREATE** | **Create DONE, Fri 03-Jul → 🎯 YC MILESTONE** |
| Wk3 | Mon 06 – Fri 10-Jul | Phase 3 — Iterate | top feedback fixed, redeployed |
| Wk4 | Mon 13 – Fri 17-Jul | Phase 4 — Test/harden + Phase 5 — Launch | **Launch, target Fri 17-Jul** |
| Wk5 | Mon 20-Jul → | Phase 6 — Suggest/scraper | (deferred — do not pull forward) |

---

## 2. The two-face product (and the deferred third)

For the YC milestone the agent has **two faces**, invoked by mention + natural language (`sawa …` / `@sawa`):

1. **SEARCH (Wk1)** — the default face, lower-risk, higher-signal. "Where can I bet on X across Sawa + the
   real-money venues?" Front-loaded to de-risk the demo.
2. **CREATE (Wk2)** — "make a market on X." The "trade on anything" magic moment.

A **third face, SUGGEST** (proactive, reply-driven topical surfacing), is **deferred to Wk5** — `src/sawa/
suggest.ts` stays **parked**; do not pull it forward. (Architecture for it already exists: `BotSuggestion` /
`BotActorState` + `/api/bot/state`.)

### 2.1 UX principles (Poke / AMB / Linq benchmark)

The decisive constraint: **Apple Messages for Business' native interactive pickers (list picker, quick reply,
forms) are OFF THE TABLE** — they require Apple Business Register onboarding via an approved MSP/CSP + per-use-
case approval, or shipping our own signed iMessage app extension. So the **entire** Search reply + Create flow
is built from **text/markdown + rich-link cards + tapback reactions + polls** (SPECTRUM_INTEGRATION §4).
**Poke** (the first Apple-approved iMessage AI agent) proves plain-text-only is enough; **Linq** ($20M, Feb-26)
shows the iMessage-AI-agent category is now established infra — so our bet is the **prediction-market vertical**,
not the channel. Principles to bake in:

1. **Bubble-sized, not paragraph-sized.** Lead with the answer in one short bubble; split long results across
   bubbles. No preamble.
2. **One compact line per source.** Skyscanner-style: `Polymarket · 63¢ YES · [open]`. Price first for
   scannability; markdown link per line; cap ~3–5 sources, "more?" on request.
3. **Exactly one clear action per message** — never a menu of competing CTAs.
4. **Confirm conversationally, not with forms.** Echo the parsed intent back and gate actions on a **tapback**
   or one-word reply — reactions *are* our quick-reply substitute.
5. **Use the channel's real affordances** — rich-link cards, tapbacks, polls, effects (sparingly, on a win) —
   never fake AMB pickers.
6. **Latency feel: acknowledge, then deliver.** Send a fast "checking the odds…" bubble (stream/`responding`)
   before slow API calls so the thread never goes silent.
7. **Virtual-coin disclaimer inline + minimal** — a short suffix on every coin/market message, not a paragraph.

---

## 3. Phase 0 — Setup & Foundations (Day 1–2, by Tue 23-Jun) — DE-RISK FIRST

Order matters: prove the riskiest unknowns before building features. Each task maps to our stack.

- **0.1 Repo + sandbox env.** Work on branch `sawa-spectrum-bot` (already off `main`). `.env`: `PROJECT_ID`/
  `PROJECT_SECRET` (Photon), `SAWA_API_BASE_URL`, `SAWA_BOT_SECRET`, `PMXT_API_KEY`, `INTENT_LLM_*`,
  `SAWA_BOT_NAME`. **Remove `SAWA_SUPABASE_*`** (Option C). A real iMessage **test group** to dogfood in.
- **0.2 ⛬ PROVE THE iMESSAGE CONNECTION (Day-1 gate — the biggest unknown).** With the Photon Spectrum
  iMessage provider: **receive a real message in the test group and post a reply.** Log + verify the live
  shapes of `message.id` (Apple GUID), `message.sender.id` (E.164 phone vs Apple-ID email), `message.space.
  {id,type,phone}`, and confirm `space.send()`'s returned id matches a later tapback `target.id`
  (SPECTRUM_INTEGRATION §2/§8). **Until this works, nothing else matters — do not start Search.**
- **0.3 Secure Kalshi + Polymarket access = pmxt.** Get `PMXT_API_KEY` (free tier 25k credits/mo, GET-only).
  Smoke-test `GET /v0/markets?query=…` and `fetchMatchedMarketClusters` (the cross-venue matcher) — confirm
  coverage + real per-call credit cost (PMXT_INTEGRATION §2–§4). pmxt **is** the "Kalshi + Polymarket API
  access" the milestone calls for (one key, both venues). Direct venue APIs are a fallback only if pmxt
  matching is insufficient.
- **0.4 Runtime skeleton + intent router.** Refactor `src/index.ts` from the slash-only loop to the
  conversational core: handle `text` / `reaction` / `poll_option` inbound; `src/sawa/intent.ts` (Gemini
  Flash-Lite via the OpenAI-compatible SDK, JSON mode, **regex-first gate**, market-list injection,
  clamp/re-verify); `src/sawa/reply.ts` (persona/voice + virtual-coin disclaimer + safety clamps). Follow the
  **Spectrum production patterns** (five-stage inbound pipeline, idempotent retries via stable `message.id`)
  from the `spectrum` skill.
- **0.5 Activation trigger + two-face UI shell.** Group **mention-gating** (`sawa …` / `@sawa`; ignore
  bystander chatter except for analytics) → route to **SEARCH** vs **CREATE** vs chat.
- **0.6 Repoint reads to the app API (Option C). ✅ DONE 22-Jun.** Rewrote `src/sawa/read.ts` from PostgREST →
  the public `GET /api/predictions` (list/paginate + client-side title search), `/api/predictions/[id]` (+
  `/odds`) for detail, and `/api/predictions/trending`; display odds computed from each option's parimutuel
  pool share. Dropped `SAWA_SUPABASE_*` from `config.ts` (added `SAWA_API_BASE_URL`); rescoped
  `tests/read-only.test.ts` to lock the GET-only, no-DB-credential read path. Reads work again; the bot holds
  no DB credentials.
- **0.7 ✓ Benchmark done (Poke / AMB / Linq)** — principles distilled in **§2.1**; key finding: AMB native
  pickers are unavailable to a third-party Spectrum bot → build the whole UX from text/markdown + richlink +
  tapback + polls (Poke-validated). Validate/extend against real chats during the build.

**Phase 0 exit:** a deployed skeleton that receives a mention in the real test group, routes it, reads live
Sawa markets over the app API, and replies in voice. (No Search logic yet.)

---

## 4. Phase 1 — SEARCH (Wed 24 – Fri 26-Jun) — ship Fri 26-Jun

**Deliverable:** a query like "FIFA World Cup" returns **matched markets from Sawa, Kalshi, and Polymarket**,
with **price and payout per source**, Skyscanner-style — **one compact line each with a tappable link.**

- **4.1 Search intent detection** — `intent.ts` classifies search vs create vs chat; extract the query subject.
- **4.2 Sawa side** — `read.ts` via the app API; **client-side fuzzy match** over the open-market feed
  (catalog is small); compute **display odds from each option's pool `volume`** (parimutuel — never recompute
  payout, BETTING_BOT_PLAN §2); deep link via `SAWA_MARKET_URL_TEMPLATE`.
- **4.3 Kalshi/Polymarket side** — `src/pmxt/` GET-only client: `GET /v0/markets?query=` + `fetchMatched
  MarketClusters(query, minConfidence)` for cross-venue price anchors. Fail-soft (a pmxt error never blocks
  the Sawa reply). Cache per query/TTL + per-space gate (cost control).
- **4.4 Matching + ranking + normalization** — unify into one row shape `{ source, title, price (¢/%),
  payout/return, url }`; rank by relevance + 24h volume; **threshold `minConfidence`** so we never show a
  bad cross-venue match.
- **4.5 Aggregated reply (the Skyscanner card)** — compact `markdown`, one line per source, **external venues
  clearly labeled real-money vs Sawa virtual coins**; `richlink` cover for the top Sawa market (never for a
  private/hidden market); cap line count; apply the **§2.1 UX principles** (bubble-sized, one line/source, one
  clear action, ack-then-deliver).
- **4.6 Empty / broad query** — no match → offer **Create** ("want me to make this market on Sawa?"); broad →
  top-k + "narrow it down."
- **4.7 Live test + analytics + deploy** — dogfood in the test group; emit `odds_lookup` / `command`
  analytics via `POST /api/bot/events` (RAW handle/spaceId, server hashes — SPECTRUM_INTEGRATION §6); deploy;
  **record the demo; log feedback.**

**DONE checklist (Fri 26-Jun):** ☐ merged to main ☐ live in the test group ☐ "FIFA World Cup" returns
Sawa+Kalshi+Polymarket lines with price+link ☐ empty/broad handled ☐ demo recorded ☐ feedback logged.

---

## 5. Phase 2 — CREATE (Mon 29-Jun – Fri 03-Jul) — ship Fri 03-Jul 🎯

**Deliverable:** "sawa make a market on X" → a created Sawa market, with the **creator as resolver**, returned
as a tappable link — built conversationally (slot-filling + follow-up questions + optional image).

- **5.1 Create intent + slot-filling** — title, options (2–20), deadline, category; ask **follow-up questions**
  for missing slots in-thread.
- **5.2 Reuse the app's AI** — `POST /api/predictions/generate` + `/predictions/demo-options` for NL→draft and
  option generation; `/predictions/generate-image` (or user **image upload**) for the cover.
- **5.3 Create call** — `POST /api/predictions` with the **requesting user's JWT** (minted via `/api/bot/
  session`; the user becomes creator/resolver and bears the creator stake). Idempotency on `message.id`.
- **5.4 Validation / guards / confirm+edit** — preview the drafted market card → **confirm or edit** before
  create; respect `predictionsEnabled` / `freeTierCreateLimit`; map typed errors to friendly voice; return the
  market link.
- **5.5 Consent** — first money/create action wires consent via `/api/bot/session`'s `acceptTerms` flag.
- **5.6 Live test + deploy + demo + feedback.**

**DONE checklist (Fri 03-Jul):** ☐ merged ☐ live ☐ NL create with follow-ups → real `Prediction` created ☐
confirm/edit works ☐ link returned ☐ demo recorded ☐ feedback logged → **YC milestone met.**

---

## 6. Phases 3–6 (post-milestone)

- **Phase 3 — Iterate (Wk3, 06–10 Jul):** triage logged feedback; fix the top issues for Search + Create;
  redeploy.
- **Phase 4 — Test / harden (Wk4, 13–17 Jul):** full QA; messy/edge inputs; multi-user concurrency in a
  group; regression; latency + cost under load. **Cross-cutting (finalize here):** analytics/logging coverage,
  cost controls, language guardrail, **YC demo recording**, channel-expansion plan (WhatsApp/Telegram via
  Spectrum providers).
- **Phase 5 — Launch (Wk4, target Fri 17-Jul):** readiness review vs a deploy checklist; go live; monitoring +
  alerting; onboarding message; watch the first 48h.
- **Phase 6 — Suggest / scraper (Wk5, from 20-Jul) — DEFERRED:** read the group feed, detect suggestable
  topics, surface one relevant market cleanly, tune relevance. **Reply-driven only — no cron/cold push**
  (there is no "app opened" event; SPECTRUM_INTEGRATION §1). Reuse `suggest.ts` + `BotSuggestion` /
  `BotActorState` / `POST /api/bot/state`.

---

## 7. Cross-cutting invariants (apply in every phase)

- **Analytics** via `POST /api/bot/events` only (batch ≤200, partial-success, RAW values → server hashes) —
  SPECTRUM_INTEGRATION §6.
- **Idempotency:** dedupe every side effect on `message.id` (at-least-once delivery).
- **Consent + virtual-coin disclaimer** on every coin/market message; durable `optedOut`.
- **Cost controls:** cheap intent model (Gemini Flash-Lite); pmxt cache + per-space gate; never call the
  cluster matcher on every group message.
- **Language guardrail:** persona/voice is a thin wrapper over deterministic facts; clamp length; never drop
  the disclaimer; no harassment.
- **Master-credential hygiene:** `SAWA_BOT_SECRET` is highest-value; deploy-env only, never logged. `/session`
  rate-limit hardening proceeds in parallel on the Sawa-app side (non-blocking).

---

## 8. Dependencies & risks (specific to this plan)

1. **iMessage live connection (Phase 0 gate)** — biggest unknown; prove Day 1.
2. **No Sawa text-search API** — v1 uses client-side matching over the small open feed; flag `?search=` as a
   scale follow-up (not a milestone blocker).
3. **pmxt cross-venue match quality + credit cost** — threshold `minConfidence`; cache; confirm cost vs free
   tier before relying on it.
4. **`/api/bot/session` master credential** — operational hardening in parallel; never block building on it.
5. **AMB rich pickers need official business onboarding** — out of v1; Spectrum richlink/poll/markdown is the
   v1 toolkit; native mini-app cards are a later ceiling.

---

## 9. Owners & repos (kills the two-agent drift)

| Repo | Agent | Owns | Never touches |
|---|---|---|---|
| **`messagesApp`** (this) | **Part B (the bot build)** | the bot + **all `docs/*` (single source of truth)** | the `Sawa-app` repo |
| **`Sawa-app`** | **Part A (the server)** | `/api/*`, DB, RLS | the `messagesApp` repo + its docs |

The repos talk **only over HTTP** (the 3 `/api/bot/*` endpoints + the public `GET /api/predictions*` reads).
Remaining Sawa-app work is tiny: **merge PR #27**, optionally **rate-limit `/api/bot/session`**, **verify
market-page OG tags**. Only the Part B side edits these docs; the Part A agent reports changes back for
reconciliation.
