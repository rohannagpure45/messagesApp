# sawagc — Sawa discovery bot

A messaging bot for **[Sawa](https://sawapredictions.com)** (the social prediction network),
built on **[Photon Spectrum](https://photon.codes/docs/spectrum-ts)** — write the handler once,
run it across **iMessage** (production) and a **terminal** TUI (development).

The default face is **cross-venue SEARCH**: ask in natural language and get matched markets from
**Sawa** (virtual coins) plus **Kalshi** and **Polymarket** (real money, via [pmxt](https://pmxt.dev)),
Skyscanner-style — one compact line per market, price + payout per source, each with a tappable link.

```
You:  sawa where can I bet on the FIFA World Cup
Sawa: 🔎 Markets for "FIFA World Cup" — Sawa · Kalshi · Polymarket
      🪙 Sawa · Who will win the World Cup? · Brazil 59% · open
      📈 Polymarket · World Cup Winner — Brazil · Brazil 22¢ (4.5×) · open
      📈 Kalshi · World Cup Winner — Argentina · Argentina 18¢ (5.6×) · open
      🪙 Sawa = virtual coins (parimutuel). 📈 Kalshi/Polymarket = real money.
      Virtual Sawa coins — entertainment only, no cash value.
```

Betting and market creation are **out of scope for this phase** — this is read-only discovery.
pmxt is read-only enrichment, never a trade host.

## Using it

In a **DM** the bot always answers. In a **group** it answers only when hailed (`sawa <topic>` /
`@sawa …`) or via a slash command — bystander chatter is ignored.

| Input | Does |
|---|---|
| `sawa <topic>` · `sawa where can I bet on <topic>` · `sawa odds on <topic>` | Cross-venue search (Sawa + Kalshi + Polymarket) |
| `/search <topic>` | The same search, as a slash command |
| `/markets` | List the newest open, public Sawa markets |
| `/show <id>` | Full detail for one Sawa market (+ a tappable link) |
| `/help` | List commands |

Natural-language intent is parsed by **Gemini Flash-Lite** behind a **regex-first gate** (the LLM is
consulted only when the gate is unsure, and only if a key is configured; otherwise the regex gate
handles it alone).

## Invariants

- **Discovery reads are GET-only, no DB credentials.** `src/sawa/read.ts` reads the Sawa app's
  **public** `GET /api/predictions*` endpoints through the `getJson` helper — no POST/PUT/PATCH/DELETE,
  no database key (Option C). The public-feed guard (`isPrivate=false`, `isHidden=false`) is enforced
  server-side; `resolved` markets are filtered client-side.
- **pmxt is GET-only and never a trade host.** `src/pmxt/*` issues only `GET` against the read/catalog
  host (`api.pmxt.dev`); the write/trade host (and its signature/escrow surface) never appears in the
  client. `tests/read-only.test.ts` enforces both the read path and the pmxt client statically.
- **No PII to chat.** The `User` table and its `email`/`phone`/`password`/`googleId` are never read or
  surfaced; pmxt receives only the market title (never a Sawa user identifier).
- **Virtual framing.** Every coin/market message keeps the "Sawa coins — no cash value" disclaimer and
  clearly distinguishes Sawa virtual coins from the real-money venues.

## Setup

```sh
npm install
cp .env.example .env        # fill in values (never commit .env)
npm run dev                 # terminal TUI (no Photon creds needed)
```

`.env` is loaded at startup by `src/env.ts`. Minimum to run search: `SAWA_API_BASE_URL`. Optional
enrichers degrade gracefully when unset — without `PMXT_API_KEY` search is Sawa-only; without
`INTENT_LLM_API_KEY` the regex gate handles intent. Set `PROJECT_ID` / `PROJECT_SECRET` (from the
[Photon dashboard](https://app.photon.codes)) to enable iMessage; without them the bot runs
terminal-only.

```sh
npm run typecheck           # tsc
npm test                    # vitest
npm run start               # run once (no watch)
```

## Layout

```
src/
  env.ts            loads ./.env into process.env (fail-soft)
  index.ts          Spectrum app + mention-gated router (iMessage + terminal)
  routing.ts        pure mention-gating + idempotency (SeenSet)
  search.ts         cross-venue aggregator (Sawa + Kalshi + Polymarket)
  venue.ts          venue-neutral result type + token-overlap relevance
  sawa/
    config.ts       env → typed Config / PmxtConfig / IntentConfig
    http.ts         GET-only Sawa fetch helper
    read.ts         Sawa app-API reads: listMarkets, getMarket, getTrending (Option C)
    intent.ts       regex-first gate + Gemini Flash-Lite intent parser
    cards.ts        Skyscanner search card (markdown + richlink builders)
    format.ts       chat-friendly rendering (slash commands)
    types.ts        Sawa Market / Outcome
    createStub.ts   /create stub (zero I/O)
    suggest.ts      rolling buffer (parked — Suggest is a later phase)
  pmxt/
    http.ts         GET-only pmxt fetch helper (bearer)
    discover.ts     per-venue Kalshi/Polymarket search, fail-soft + cached
tests/              vitest: search / pmxt / intent / cards / routing / read / formatting / static guards
docs/               BETTING_BOT_PLAN · BUILD_PLAN · SPECTRUM_INTEGRATION · PMXT_INTEGRATION · DATABASE_MAP
```

## Roadmap

- **CREATE** — "sawa make a market on X" → a created Sawa market (the next YC-milestone flow).
- The money half (betting via the app's authenticated API) and analytics — later phases; the bot
  never writes the live DB directly.
- More surfaces: `spectrum-ts` also ships **Slack**, **Telegram**, and **WhatsApp Business** providers
  — add one by importing it in `src/index.ts` and listing it in `providers`.
