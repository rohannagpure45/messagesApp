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

- **Read-only by construction.** The read path issues only HTTP `GET`; there is no
  POST/PUT/PATCH/DELETE codepath. `tests/read-only.test.ts` enforces this statically.
- **No PII to chat.** Queries use a hard-coded column allowlist and the public-feed filter
  (`isPrivate=false`, `isHidden=false`, `resolved=false`). The `User` table and its
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
provider; without them the bot runs terminal-only. `SAWA_SUPABASE_URL` / `SAWA_SUPABASE_KEY`
enable the read commands.

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
    read.ts         PostgREST reads: listMarkets, getMarket, latest odds
    format.ts       chat-friendly rendering
    createStub.ts   /create stub (zero I/O)
    suggest.ts      rolling message buffer + /suggest payload
    types.ts        Market / Outcome
tests/              vitest: formatting + read-only/static guarantees
docs/
  DATABASE_MAP.md   full Sawa Postgres/Supabase schema + read contract
```

## Data model

The bot reads the live Sawa Postgres/Supabase database. Its full schema — tables, columns,
relationships, and the public-feed read contract — is mapped in
[`docs/DATABASE_MAP.md`](docs/DATABASE_MAP.md).

## Roadmap

- Kalshi as a second read venue (the `Market`/`Outcome` types are already venue-neutral).
- The "money half" (order engine / payouts) — a later phase that reuses the Sawa app's own
  logic; the bot never writes the live DB directly.
- More surfaces: `spectrum-ts` also ships **Slack**, **Telegram**, and **WhatsApp Business**
  providers — add one by importing it in `src/index.ts` and listing it in `providers`.
