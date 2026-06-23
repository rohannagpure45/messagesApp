# Testing the SEARCH bot — terminal & live iMessage

How to exercise Phase 1 **SEARCH** end to end. Two tiers: a **terminal** smoke test (no credentials, ~30s)
and the **live iMessage** dogfood (the real channel — this is also the Phase-0 §3.2 "prove the connection"
gate, still unproven).

> **Scope:** SEARCH is read-only discovery — it returns markets from Sawa (virtual coins) + Kalshi +
> Polymarket (real money). There is **no betting or market creation yet** (later phases). It reads Sawa's
> **public production** API (read-only) and pmxt; it holds no DB or bot credentials.

---

## 0. One-time setup

`.env` (gitignored) needs, at minimum, `SAWA_API_BASE_URL`. The search enrichers are optional but already
configured in this repo's `.env`:

| Var | Needed for | If missing |
|---|---|---|
| `SAWA_API_BASE_URL=https://sawapredictions.com` | Sawa results (required) | bot replies "Sawa isn't configured yet" |
| `INTENT_LLM_API_KEY` (Gemini) | smarter intent parsing | falls back to the regex gate (explicit phrasings still work) |
| `PMXT_API_KEY` | Kalshi + Polymarket results | search returns **Sawa-only** |
| `PROJECT_ID` + `PROJECT_SECRET` (Photon) | **live iMessage** | runs **terminal-only** |

Get Photon creds from the [Photon dashboard](https://app.photon.codes) → project **Settings**.
`PMXT_API_KEY` from [pmxt.dev/dashboard](https://pmxt.dev/dashboard); Gemini from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

```sh
npm install
npm run typecheck && npm test   # sanity: tsc clean + tests green
```

---

## 1. Terminal test (fastest — no Photon creds)

```sh
npm run dev          # terminal TUI; loads .env, runs Sawa + pmxt + Gemini for real
```

Type queries at the prompt (slash commands and natural language both work):

```
/search FIFA World Cup
sawa where can I bet on the 2026 election
sawa bitcoin
/help
```

You should see the Skyscanner card: a lead line, one compact line per market grouped Sawa → Kalshi →
Polymarket, each with a price / payout and an `[open](…)` link, then the disclaimer footer. This proves the
**logic + live data** path; it does not prove iMessage rendering (Section 2).

---

## 2. Live iMessage test (the real dogfood)

1. Put `PROJECT_ID` + `PROJECT_SECRET` in `.env`, then:
   ```sh
   npm run start
   ```
   On boot you'll see `[sawa] search enrichment — pmxt: on; intent LLM: on.` and the iMessage provider
   connecting. (On the Photon **free/pro** plan each recipient is routed through a number from a shared pool;
   on **Business**, a single dedicated number — see `.agents/skills/spectrum/providers/imessage.md`.)

2. **Start a conversation with the bot's number.** From the Photon dashboard, find the line/number your
   project sends from (or send yourself a test message). Then in the Messages app:
   - **DM:** text the bot directly — it answers **every** message.
   - **Group:** add the bot's number to a group. In a group it only answers when **hailed** — start the
     message with `sawa …` or include `@sawa`. Bystander chatter is ignored by design.

3. **Send these and check the reply:**

   | Send | Expect |
   |---|---|
   | `sawa FIFA World Cup` | Sawa + Kalshi + Polymarket lines, prices, payouts, links, disclaimer |
   | `sawa where can I bet on the LA mayor election` | a competitive race surfaced (e.g. a 60–70¢ favorite) |
   | `sawa bitcoin` | Kalshi/Polymarket bitcoin markets (Sawa may have none) |
   | `sawa asdfqwer nonsense` | empty-state: "No live markets … try a broader term" + create tease |
   | `hey sawa` | a short nudge ("I find prediction markets…") — not a search |
   | (in a group) `nice game last night` | **no reply** (not hailed) |

   The **top Sawa market** also arrives as a native **rich-link card** (cover image + title) — that bubble is
   guaranteed tappable.

### Acceptance (what "Search works in iMessage" means)
- ☐ The bot receives a group message and replies (the connection gate).
- ☐ "FIFA World Cup" returns Sawa + Kalshi + Polymarket lines with price + payout + a link each.
- ☐ Real-money venues are clearly labeled vs Sawa virtual coins; the disclaimer is present.
- ☐ Empty/broad queries and a bare greeting are handled.
- ☐ Mention-gating: ignored in a group unless hailed; always answers in a DM.

---

## 3. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot silent in a **group** | Not hailed — start with `sawa …` or `@sawa`. DMs always answer. |
| `Sawa isn't configured yet` | `SAWA_API_BASE_URL` unset in `.env`. |
| Only **Sawa** results, no Kalshi/Polymarket | `PMXT_API_KEY` unset, or pmxt 429/down (search is **fail-soft** → Sawa-only). pmxt limit is 60 req/min; results are cached 60s. |
| Intent feels off on loose phrasing | `INTENT_LLM_API_KEY` unset → regex gate only. Explicit phrasings ("find X", "odds on X", "sawa X") still classify. |
| `[open](url)` shows as literal text | iMessage may not render markdown link syntax — the rich-link cover card is the guaranteed-tappable element. **This is the one thing to confirm in a live chat**; if links aren't tappable, switch the card to raw URLs (a quick follow-up). |
| Photon auth error on boot | Verify `PROJECT_ID` / `PROJECT_SECRET` on the [dashboard](https://app.photon.codes). Without them the bot runs terminal-only. |
| Duplicate replies | Shouldn't happen — replies dedupe on `message.id`. If seen, capture the id. |

---

## 4. What you **cannot** test yet

Betting, market **creation**, and **analytics** are not built — and even when built they need the Sawa-app
`/api/bot/*` endpoints, which are **MERGED (PR #26 + #27) but not yet deployed to Vercel** (`POST /api/bot/*`
→ 404 on prod today; the deploy is gated on the repo owner's Sawa Vercel-org membership). Deploy the merged
`main` to Vercel (with `BOT_SECRET` / `BOT_HASH_SECRET` set) before those phases. See
[`BUILD_PLAN.md`](BUILD_PLAN.md) §0.

## 5. Troubleshooting note — "Delivered" but no reply (the multi-instance trap)

If iMessage shows **Delivered** but the bot never replies:

1. **First suspect — more than one bot instance running** (duplicates fight over the Photon line; Photon
   delivers your text to only one). The bot now has a **single-instance lock** — a second `bun start` exits
   with `✋ Another sawa instance is already running`. Verify only one is up: `pgrep -fl "src/index.ts"`.

2. **If exactly one instance is running, connected, and `listening`, yet the log shows NO `⟵ event` when you
   text → inbound is not reaching the SDK at all.** Confirmed 23-Jun: this persists across **spectrum-ts
   4.2.0 AND 5.2.0**, with the socket ESTABLISHED to Photon's prod cluster (`*.elb.us-west-1.amazonaws.com`).
   This rules out our code, the SDK, creds, webhooks, and duplicates. **A 100s connection-stability watch
   then ruled out the network too:** the socket to Photon's prod ELB stayed **stable across minutes with
   ZERO reconnect/error churn** in the verbose 5.x logs — a network/proxy breaking the stream would show
   reconnect churn, and there was none. So this is a **healthy, stable connection that simply receives no
   inbound → Photon is not routing your texts to the connected client.** That is a **Photon account/line
   issue.** In order:
   - **Dashboard / re-provision the line (primary).** Photon's own integration troubleshooting maps the
     exact symptom "connected but no inbound" to a **line-provisioning** problem ("Spectrum is enabled but no
     line has been provisioned — re-run setup or check the dashboard"). So: confirm a line is actually
     **provisioned + active**, your phone is on **Users** and **still mapped** to it (shared-pool assignments
     can rotate — **remove and re-add your phone**, or re-provision the line), the **iMessage platform is
     enabled** (Platforms page), and **no webhook** is set. If the dashboard shows an inbound log, check
     whether your texts appear there at all. (Inbound is confirmed to flow over the SDK's `app.messages`
     **gRPC stream** — which the bot consumes correctly — so this is purely a Photon-side routing/provisioning
     matter.)
   - **Stock-echo control:** scaffold a fresh `bun create spectrum-project@latest` echo and text it on the
     same account. If even *that* receives nothing, it's conclusively the Photon account/line → **email
     Photon support (ryan@photon.codes)**: "project `sawagc`, free shared-pool line `+1 628 264-7704`: the
     SDK client maintains a stable connection to your prod cluster but receives zero inbound over the
     `app.messages` gRPC stream; tested on spectrum-ts 4.2.0 and 5.2.0, single instance, no webhook, phone
     added to Users." If the stock echo *does* work, capture the diff vs this repo and we'll chase it.
   - **(Low likelihood now)** a phone hotspot, only because it's a 30-second test — but the stable, churn-free
     connection makes a network cause unlikely.

   The repo ships `imessage-echo.ts` (a 15-line isolation echo that shares the lock) — run it alone to
   reproduce with the smallest possible surface.
