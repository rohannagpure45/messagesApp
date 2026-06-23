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

If iMessage shows **Delivered** but the bot never replies, the #1 cause is **more than one bot instance
running at once** — duplicates fight over the Photon line and Photon delivers your text to only one of them,
so replies vanish. The bot now has a **single-instance lock**: a second `bun start` exits with
`✋ Another sawa instance is already running` instead of dueling. If you still get no reply with exactly one
instance and the log shows no `⟵ event` when you text, the inbound isn't reaching the SDK at all — run the
isolation echo (`npx tsx imessage-echo.ts`, alone); if even that logs nothing on a text, it's Photon-side
inbound delivery (take it to Photon support), not this bot.
