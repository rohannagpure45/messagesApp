# sawagc — agent instructions

This is a [Spectrum](https://photon.codes/docs/spectrum-ts) app, on `spectrum-ts@^5.2.0` (upgraded from 4.2.0 while debugging iMessage delivery). The entry point is `src/index.ts`, which loads `.env` (via `src/env.ts`), configures the providers (iMessage + terminal), and runs a **live, conversational Sawa prediction-market agent** (Folk-style "trade from the chat"): natural-language odds lookup, on-the-fly market creation, and per-user betting with real Sawa coins, plus reaction/poll-driven engagement and analytics.

**Read the plan before building:** [`docs/BETTING_BOT_PLAN.md`](docs/BETTING_BOT_PLAN.md) (authoritative product/architecture plan) and [`docs/SPECTRUM_INTEGRATION.md`](docs/SPECTRUM_INTEGRATION.md) (identifiers, inbound events incl. reactions, analytics mapping). Live betting/creation goes through the Sawa web app's authenticated API with a per-user JWT (minted via the web app's `POST /api/bot/session`); analytics go through `POST /api/bot/events`.

**Current status:** Phase 1 **SEARCH** is built and **verified live in iMessage** (24-Jun): multi-entity queries (e.g. "Switzerland, India") return a full cross-venue card, and topic queries (e.g. "Shark Tank") return Sawa markets with a native rich-link cover. A natural-language query ("sawa FIFA World Cup") returns matched markets from **Sawa** (`src/sawa/read.ts`, Option C), **Kalshi** and **Polymarket** (`src/pmxt/`, GET-only, fail-soft) as one **emoji-free** Skyscanner card (`src/sawa/cards.ts`) that leans on cloud iMessage's native markdown — bold venue headers + tappable `[open](…)` links, confirmed rendered as styled text via UTF-16 formatting ranges (`@spectrum-ts/core`). Intent = regex-first gate + Gemini Flash-Lite (`src/sawa/intent.ts`); aggregation/ranking in `src/search.ts`; mention-gating, idempotency, and sender-handle normalization in `src/routing.ts`. **Group chat** is mention-gated and group-ready in code, but Photon's docs confirm *"shared mode cannot create group chats"* — dependable groups need a dedicated (Business) line (the free/pro shared pool routes each end user through a *different* number, the "different numbers" symptom; an *existing* group may be reachable via `space.get(chatGuid)` — worth testing before upgrading). Betting, market creation, and analytics are **not yet built** (later phases). pmxt verified live: text search is `?q=` (not `query`), venue filter is `?sourceExchange=kalshi|polymarket`. **Deployment gate (verified 23-Jun):** the Sawa-app `/api/bot/*` endpoints those future phases need are **MERGED** (PR #26 + #27 on `main`) but **NOT deployed to Vercel/prod** — `POST /api/bot/*` → 404 (deploy gated on the owner's Sawa Vercel-org membership). The DB/RLS is live and the public `GET /api/predictions*` read path Search uses is live (200). Deploy the merged code to Vercel (with `BOT_SECRET`/`BOT_HASH_SECRET`) before Create/betting/analytics. To test Search live in iMessage, see [`docs/IMESSAGE_TESTING.md`](docs/IMESSAGE_TESTING.md).

## Working in this project

- Run the app with `npm run start` (or `npm run dev` for watch + terminal-only).
- Run `npm run typecheck` (tsc) and `npm test` (vitest) before declaring work done.
- Add providers by importing them in `src/index.ts` and listing them in the `Spectrum({ providers: [...] })` config. `spectrum-ts/providers/*` ships `imessage`, `terminal`, `slack`, `telegram`, and `whatsapp-business`.
- Outgoing message content uses the builders documented in the skill (text, attachment, voice, contact, richlink, poll, group, custom).

## Sawa invariants (do not break)

- **Writes only through the authenticated API / bot endpoints — never direct table writes.** The bot
  places bets and creates markets via the Sawa web app's HTTP API using a per-user JWT (from
  `POST /api/bot/session`); it emits analytics via `POST /api/bot/events`. It must **never** write the
  Sawa Postgres directly (no PostgREST/anon writes, no raw SQL). *(This replaces the former "read-only by
  construction" invariant; `tests/read-only.test.ts` is rescoped to assert the **discovery read path** —
  `src/sawa/read.ts` + `getJson` — stays GET-only.)*
- **Discovery reads stay GET-only + PII-guarded.** Reads go through the app's **public** `GET
  /api/predictions*` endpoints (Option C, shipped in task 0.6 — `src/sawa/read.ts`), which enforce the
  public-feed guard (`isPrivate=false`, `isHidden=false`) server-side; `resolved` is filtered client-side.
  The bot holds **no** DB credentials. Never query or surface the `User` table or
  `email`/`phone`/`password`/`googleId`. *(Part A's RLS deny-all on all 41 tables retired the old anon-key
  PostgREST path; see `docs/BETTING_BOT_PLAN.md` §6 read-path note + decision §2.14.)*
- **Analytics are PII-minimal.** The bot sends RAW handle/spaceId to `POST /api/bot/events`; the **server**
  HMAC-hashes them (`BOT_HASH_SECRET` — the bot never holds it), resolves `userId`, and stores **only hashes**
  (no message bodies; `meta` hard-whitelisted by `clampMeta`). RLS is deny-all on all 41 public tables (anon +
  authenticated). See `docs/SPECTRUM_INTEGRATION.md` §6.
- **Consent + virtual framing.** Capture one-time in-chat consent before the first money action; amounts
  are "Sawa coins" with a no-cash-value disclaimer on every coin/market message.
- References: [`docs/BETTING_BOT_PLAN.md`](docs/BETTING_BOT_PLAN.md), [`docs/SPECTRUM_INTEGRATION.md`](docs/SPECTRUM_INTEGRATION.md), [`docs/DATABASE_MAP.md`](docs/DATABASE_MAP.md).

## Environment

This project reads secrets from `.env` (gitignored), loaded at startup by `src/env.ts`. **Do not read, write, or echo `.env`** — it holds credentials (`PROJECT_ID`, `PROJECT_SECRET`, the live-API config `SAWA_API_BASE_URL` (public reads + bot endpoints) / `SAWA_BOT_SECRET`, and the intent-LLM key `INTENT_LLM_API_KEY`). The read path uses only `SAWA_API_BASE_URL` — no DB key (Option C). `SAWA_BOT_SECRET` (= the web app's `BOT_SECRET`) authenticates the bot to `/api/bot/*` and is effectively a **master credential**: `POST /api/bot/session` mints a valid 7-day user JWT for **any** handle resolvable by phone/email — including funded real accounts. Treat it as the highest-value secret; never log/echo it; scope it tightly. The bot must **never** hold `BOT_HASH_SECRET` or `JWT_SECRET` — those are server-only in `../Sawa-app`.

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
