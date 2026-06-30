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

You should see a **conversational single-market reply**: ONE natural line naming the favorite (+ a runner-up
for head-to-heads) and venue — e.g. `Who will win the World Cup? — Brazil 59%, Argentina 41% on Sawa.` —
with **no emoji, no link, and no disclaimer**. Real-money venues read as real money (cents + return multiple,
e.g. `… — Karen Bass 65¢ (1.5×) on Kalshi.`). Then try follow-ups in the same thread: `not that` (pages to the
next market), `send the kalshi link` (that venue's bare URL, or a graceful "no Kalshi market for that"). This
proves the **logic + live data + conversation** path; it does not prove iMessage rendering (Section 2).
*(Redesigned 24-Jun from the 3×3 "Skyscanner card" — see `PROGRESS.md`.)*

---

## 2. Live iMessage test (the real dogfood)

1. Put `PROJECT_ID` + `PROJECT_SECRET` in `.env`, then:
   ```sh
   npm run start
   ```
   On boot you'll see `[sawa] search enrichment — pmxt: on; intent LLM: on.` and the iMessage provider
   connecting. (On the Photon **free/pro** plan each recipient is routed through a number from a shared pool;
   on **Business**, a single dedicated number — see `.agents/skills/spectrum/providers/imessage.md`.)

   > **Recommended on a shared pool: let the bot text YOU first.** On the free/pro shared pool, the
   > inbound→SDK route for an end user is established when the project *initiates* the conversation to that
   > registered user. Cold-texting a pool number the bot never addressed you from may not route back (a
   > common cause of "Delivered, no reply"). Set `SAWA_HELLO_TO` to your handle and the bot sends you a
   > greeting on boot:
   > ```sh
   > SAWA_HELLO_TO="+1XXXXXXXXXX" npm run start
   > ```
   > Watch the boot log: `✅ hello → +1…: sent` means outbound + handle are good — **reply in that thread**
   > and your inbound should now route (`⟵ inbound [iMessage/dm]`). `❌ hello … FAILED … Target not allowed`
   > means the handle isn't in **Users** or isn't the one Apple sends you from → verify at
   > [debug.photon.codes](https://debug.photon.codes). Comma-separate to greet several handles.

2. **Start a conversation with the bot's number.** From the Photon dashboard, find the line/number your
   project sends from (or use `SAWA_HELLO_TO` above to have the bot open the thread). Then in the Messages app:
   - **DM:** text the bot directly — it answers **every** message.
   - **Group:** add the bot's number to a group. In a group it only answers when **hailed** — start the
     message with `sawa …` or include `@sawa`. Bystander chatter is ignored by design.

   > **Groups need a dedicated (Business) line — confirmed by Photon's docs.** Per
   > [docs.photon.codes](https://docs.photon.codes) (iMessage routing → Creating conversations):
   > *"Shared mode cannot create group chats. Use a dedicated number, or `space.get(chatGuid)` for an
   > existing group."* On the free/pro **shared pool** each end user is routed through a *different*
   > number, so a group can't resolve to one coherent bot identity — the "both users on different
   > numbers" symptom. Mention-gating, group detection, and `normalizeHandle()` (`src/routing.ts`) are
   > already in code; dependable groups are a **line-model** upgrade, not a code change.
   >
   > **Tested 24-Jun — CONFIRMED: shared-pool groups don't route inbound.** Run 1 (group with
   > `+1 628-264-7704` + a 2nd member) logged zero group `⟵ event` but was discarded for a boot-race (bot
   > started the same minute). Run 2 was clean — bot listening 28 min — and a fresh group send still
   > produced **zero** group inbound, while DMs to 628 in the same window routed fine. So a dedicated
   > (Business) line is required for groups, as the docs (*"shared mode cannot create group chats"*) say.
   > (Note: both DM *replies* failed on Photon's send side this session with transient
   > `DEADLINE_EXCEEDED`/`ECONNRESET` — inbound OK, outbound flaky.) **Quotas:** 50 new conversations
   > per line/day (caps `SAWA_HELLO_TO`
   > outreach) and 5,000 messages per server/day. Identity helpers from the same page:
   > `message.sender.service` (`iMessage`/`SMS`/`RCS`) and `.address` via narrowing.

3. **Send these and check the reply:**

   | Send | Expect |
   |---|---|
   | `sawa FIFA World Cup` | ONE conversational line: the favorite market + venue (e.g. `… Brazil 59% on Sawa.`) — no card, no disclaimer |
   | `not that` (after a result) | the next-best market, one line |
   | `send the kalshi link` (after a result) | a bare Kalshi URL (cloud iMessage previews it), or "I don't have a Kalshi market for that" |
   | `sawa where can I bet on the LA mayor election` | a competitive race surfaced (e.g. a 60–70¢ favorite) |
   | `sawa bitcoin` | a bitcoin market (Kalshi/Polymarket; Sawa may have none) |
   | `sawa asdfqwer nonsense` | empty-state: "No live markets … try a broader term" + create tease |
   | `hey sawa` | a short nudge ("I find prediction markets…") — not a search |
   | (in a group) `nice game last night` | **no reply** (not hailed) |

   When you ask for a link in a follow-up (`send the kalshi link`), the bot sends the **bare URL** — cloud
   iMessage renders it as a native rich-link preview, so that bubble is tappable.

### Acceptance (what "Search works in iMessage" means)
- ☐ The bot receives a group message and replies (the connection gate).
- ☐ "FIFA World Cup" returns ONE conversational line: the favorite market + venue + price (no card, no disclaimer).
- ☐ Real-money venues (Kalshi/Polymarket) read as real money (cents + return multiple) vs Sawa odds %.
- ☐ Follow-ups work in-thread: "not that" pages the next market; "send the kalshi link" returns that venue's URL (or a graceful miss).
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
| `**bold**` / `[open](url)` shows as literal syntax | Only on **local mode** (SQLite), which has no styling. **Cloud** iMessage renders markdown as native styled text — bold + tappable links via UTF-16 formatting ranges (confirmed in `@spectrum-ts/core`). The bot runs cloud mode, so this shouldn't occur; the rich-link cover is still the guaranteed-tappable element. |
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

> **✅ RESOLVED for `sawagc` (23-Jun) — it was a dead Photon line, not the code.** With Full Disk Access
> granted, reading the user's own `~/Library/Messages/chat.db` proved the shared-pool line **+16282647704** is
> a valid registered iMessage handle (`service=iMessage`) but moves **no iMessage in either direction**: the
> line has delivered the user **0 messages ever** (`is_from_me=0` count = 0), and a bot-initiated send
> (`SAWA_HELLO_TO`) returned SDK **`✅ sent` yet never landed** in the live DB. Inbound shows "Delivered" but
> never reaches the SDK. ⇒ **de-registered / mis-provisioned shared-pool line → Photon-side fix** (rotate the
> line or move to a dedicated Business line). The full evidence + ready-to-send report is in
> [`PHOTON_SUPPORT.md`](PHOTON_SUPPORT.md). The steps below remain the correct *first-pass* triage for the
> generic symptom before you reach that conclusion.

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
   - **Make the bot text YOU first (`SAWA_HELLO_TO`) — fastest, and it self-diagnoses.** `SAWA_HELLO_TO="+1…"
     npm run start` initiates the conversation from the project's line, which is how the shared-pool
     inbound→SDK route gets established (cold-texting a never-addressed pool line can simply not route back).
     Two outcomes, both useful: **`✅ hello … sent`** → reply in that thread; inbound should now flow
     (`⟵ inbound`). **`❌ hello … FAILED` / "Target not allowed for this project"** → the handle isn't in
     **Users** or isn't the one Apple sends from → do the debug.photon.codes check below, fix Users, retry.
   - **Verify the actual SENDING HANDLE first ([debug.photon.codes](https://debug.photon.codes)) — most
     likely cause, 60-second check.** On shared-pool, Photon routes inbound by mapping `inbound sender
     handle → a registered user of the project → your SDK session`. If the handle Apple actually sends your
     iMessage *from* (often your **Apple-ID email**, or a number formatted differently than the one you
     added) is **not** on the Users page, Photon can't associate your text with the project and never routes
     it to the stream — yet "Delivered" still shows (that's Apple's receipt for the bot's *outbound* to your
     registered number) and the connection stays healthy. This matches the exact symptom. **Fix:** open
     [debug.photon.codes](https://debug.photon.codes) on the test iPhone; the debug bot replies with the
     exact handle Apple sends from. If it's an **email**, either add that email under **Users** *or* set
     **Settings → Messages → Send & Receive → "Start new conversations from"** to your number; if it's a
     differently-formatted **number**, add that exact string. Then retext. (If the reported handle already
     matches Users exactly, move to the next step.)
   - **Dashboard / re-provision the line (secondary).** Photon's own integration troubleshooting maps the
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
