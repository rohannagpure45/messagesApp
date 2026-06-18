# messagesApp

**Sawa messagesApp** — a Telegram group-chat **prediction-market discovery bot**, driven by
OpenClaw, that reads the live Sawa product's markets plus Kalshi and talks to a group chat.

> ⚠️ **Placeholder repo.** No code yet — this repo currently holds only the consolidated
> project knowledge. The Sawa Python package (`sawa/`) and OpenClaw skill (`skills/sawa/`)
> are built per the plan in a later pass.

## Start here

- **[docs/SAWA_CONSOLIDATED.md](docs/SAWA_CONSOLIDATED.md)** — the single source of truth:
  what Sawa is, the load-bearing context, invariants, runtime/CLI contract, architecture +
  module contracts, build sequence, test matrix, deployment, and Supabase MCP config.

## At a glance

- **Phase 1 is strictly read-only** — discovery only; no writes, no bets, no real money.
- **Sawa is a LIVE, virtual product** — "Sawa coins", no cash value. Kalshi is a data source only.
- **Runtime:** Python 3.9, stdlib only.
