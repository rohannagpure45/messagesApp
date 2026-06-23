# sawagc — Sawa discovery bot

A messaging bot for **[Sawa](https://sawapredictions.com)** (the social prediction network),
built on **[Photon Spectrum](https://photon.codes/docs/spectrum-ts)** — write the handler once,
run it across **iMessage** (production) and a **terminal** TUI (development).

Phase 1 is **read-only discovery**: browse and search live Sawa markets from chat. No bets, no
writes, no real money.

## Commands

| Command | Does |
|---|---|
| `/markets` | List the newest open, public markets with current odds |
| `/search <words>` | Search open markets by title |
| `/show <id>` | Full detail for one market (+ a tappable link if configured) |
| `/create <question>` | **Preview only** — echoes what would be created; writes nothing |
| `/suggest` | Emits recent chat + a market snapshot for an agent to propose ideas |
| `/help` | List commands |

## Invariants

- **Discovery reads are GET-only.** `src/sawa/read.ts` issues only HTTP `GET`, through the
  `getJson` helper; there is no POST/PUT/PATCH/DELETE codepath and it holds no DB credentials.
  `tests/read-only.test.ts` enforces this statically.
- **No PII to chat.** Reads hit the Sawa app's **public** `GET /api/predictions*` endpoints,
  which enforce the public-feed guard (`isPrivate=false`, `isHidden=false`) server-side;
  `resolved` markets are filtered out client-side. The `User` table and its
  `email`/`phone`/`password`/`googleId` are never read or surfaced.
- **Virtual framing.** All amounts are "Sawa coins" with a no-cash-value disclaimer.

## Setup

```sh
npm install
cp .env.example .env        # fill in values (never commit .env)
npm run dev                 # terminal TUI (no Photon creds needed)
```

`.env` is loaded at startup by `src/env.ts` — `tsx` and `node` do **not** auto-load it, so the
app calls `process.loadEnvFile()` itself (fail-soft when absent). Set `PROJECT_ID` /
`PROJECT_SECRET` (from the [Photon dashboard](https://app.photon.codes)) to enable the iMessage
provider; without them the bot runs terminal-only. `SAWA_API_BASE_URL` (e.g.
`https://sawapredictions.com`) enables the read commands — the bot reads the app's public GET
endpoints, so no database key is needed.

```sh
npm run typecheck           # tsc
npm test                    # vitest
npm run start               # run once (no watch)
```

## Layout

```
src/
  env.ts            loads ./.env into process.env (fail-soft)
  index.ts          Spectrum app + command router (iMessage + terminal)
  sawa/
    config.ts       env → typed Config
    http.ts         GET-only fetch helper (typed errors)
    read.ts         app-API reads: listMarkets, getMarket, getTrending (Option C)
    format.ts       chat-friendly rendering
    createStub.ts   /create stub (zero I/O)
    suggest.ts      rolling message buffer + /suggest payload
    types.ts        Market / Outcome
tests/              vitest: formatting + read-only/static guarantees
docs/
  DATABASE_MAP.md   full Sawa Postgres/Supabase schema + read contract
```

## Data model

The bot reads live Sawa markets over the web app's **public** `GET /api/predictions*` endpoints
(no DB access — "Option C", see [`docs/BETTING_BOT_PLAN.md`](docs/BETTING_BOT_PLAN.md) §6). The
underlying Sawa schema — tables, columns, relationships — is mapped in
[`docs/DATABASE_MAP.md`](docs/DATABASE_MAP.md) for reference.

## Roadmap

- Kalshi as a second read venue (the `Market`/`Outcome` types are already venue-neutral).
- The "money half" (order engine / payouts) — a later phase that reuses the Sawa app's own
  logic; the bot never writes the live DB directly.
- More surfaces: `spectrum-ts` also ships **Slack**, **Telegram**, and **WhatsApp Business**
  providers — add one by importing it in `src/index.ts` and listing it in `providers`.
