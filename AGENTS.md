# sawagc — agent instructions

This is a [Spectrum](https://photon.codes/docs/spectrum-ts) app, pinned to `spectrum-ts@^4.2.0`. The entry point is `src/index.ts`, which loads `.env` (via `src/env.ts`), configures the providers (iMessage + terminal), and runs a **read-only** Sawa market command router.

## Working in this project

- Run the app with `npm run start` (or `npm run dev` for watch + terminal-only).
- Run `npm run typecheck` (tsc) and `npm test` (vitest) before declaring work done.
- Add providers by importing them in `src/index.ts` and listing them in the `Spectrum({ providers: [...] })` config. `spectrum-ts/providers/*` ships `imessage`, `terminal`, `slack`, `telegram`, and `whatsapp-business`.
- Outgoing message content uses the builders documented in the skill (text, attachment, voice, contact, richlink, poll, group, custom).

## Sawa invariants (do not break)

- **Read-only by construction.** Everything in `src/sawa` issues only HTTP `GET` — no POST/PUT/PATCH/DELETE. `tests/read-only.test.ts` enforces this statically; keep it green.
- **No PII to chat.** Reads use a hard-coded column allowlist + the public-feed filter (`isPrivate=false`, `isHidden=false`, `resolved=false`). Never query or surface the `User` table or `email`/`phone`/`password`/`googleId`.
- **Virtual framing.** Amounts are "Sawa coins" with a no-cash-value disclaimer.
- Data-model reference: [`docs/DATABASE_MAP.md`](docs/DATABASE_MAP.md).

## Environment

This project reads secrets from `.env` (gitignored), loaded at startup by `src/env.ts`. **Do not read, write, or echo `.env`** — it holds credentials (`PROJECT_ID`, `PROJECT_SECRET`, `SAWA_SUPABASE_*`).

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
