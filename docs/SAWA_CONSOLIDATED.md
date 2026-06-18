# Sawa — Consolidated Project Knowledge

> Single source of truth for the **Sawa bot** — a Telegram group-chat prediction-market
> discovery bot driven by OpenClaw. This document consolidates the Phase 1 build plan, the
> load-bearing project context, the invariants, the runtime/CLI contract, the architecture +
> module contracts, the build sequence, the test matrix, deployment, and the Supabase MCP
> config into one place so it travels with this repo. See the **Provenance** footer for sources.

---

## 1. What Sawa is

A **Telegram group-chat bot**, driven by **OpenClaw**, that lets a group **discover
prediction markets by talking to it** — searching the *existing* live Sawa product and
**Kalshi** side by side — plus a **stubbed** create-market flow and a **one-shot**
chat-analysis that suggests new markets.

**No writes, no bets, no real money.** The "money half" (the order engine) is a deliberate
later phase. Phase 1 is read-only discovery.

Two distinct things are involved:
1. **The Sawa bot** — the actual product (this repo's reason for existing).
2. **OpenClaw** — the agent runtime on-device (gpt-5.5-mini) that hosts the Telegram surface,
   exec, skills, and `/setcommands`. (The original work was scaffolded inside a clone of the
   **gstack** AI-engineering toolkit, which is reference tooling, not the product.)

---

## 2. Critical load-bearing context (not derivable from code)

- **Sawa is a LIVE product, not greenfield.** It runs on a Supabase Postgres project
  (`vmuuxsjafmkcdrcxouot`, `https://vmuuxsjafmkcdrcxouot.supabase.co`) with **~313 real
  users**. The web app (Next.js + Prisma) lives in a **separate repo, not here**.
- **Schema is camelCase / cuid.** Core tables: `Prediction`, `Option`, `Bet`, `Transaction`,
  `OddsSnapshot`, `User`, `League`, and `WhatsAppInbound` (an existing inbound-messaging
  channel — the Telegram bot is a *second* such channel, mirroring its proven pattern).
- **It is deliberately VIRTUAL.** `PlatformSettings.platformMode='virtual'`, currency =
  "Sawa coins", disclaimer "Virtual currency for entertainment only. No cash value."
  (`feePercent=1`, `monthlyGrantAmount=1000`, `maxBetAmount=100`.) **Never reintroduce real
  money or real Kalshi *trading*** — that contradicts the shipped, regulatory-safe product.
  **Kalshi is a real-world data source only.**
- **Money is integer "Sawa coins"** (`User.balance` default 100, `monthlyGrantAmount` 1000,
  `maxBetAmount` 100) — **NOT USD cents**.
- **Markets use dynamic odds** (`creatorLiquidityPct`, `OddsSnapshot.percentage` time-series,
  `earlyBirdBonusWeight`), **NOT flat parimutuel**.

---

## 3. Invariants (must hold in any bot code)

- **Read-only by construction:** Phase 1 is strictly read-only. The discovery CLI issues only
  HTTP **GET**; there is **no POST/PATCH/DELETE codepath anywhere**. Pin it with a static test
  that asserts no write-method strings exist in the source.
- **No PII to chat:** query only market tables/columns; **never** read or surface `User` PII
  (`email` / `phone` / `password` / `googleId`). Every Sawa query hard-codes a column allowlist
  and `isPrivate=eq.false&isHidden=eq.false`.
- **Stub-create writes nothing** and must clearly state nothing was created. Real writes / the
  order engine are a later phase that reuses the Sawa app's logic (its API or new bot endpoints)
  — **never re-implement the economy and never write the live DB directly**.
- **Supabase key:** the device uses the existing (write-capable, `service_role`) key
  **GET-only** as a **documented accepted risk**; **never log/echo it**. A dedicated read-only
  role/grant is the deferred hardening. Key lives in a `0600` env file, never committed.

---

## 4. Runtime, environment & CLI commands

- **Runtime:** Python **3.9**, **stdlib only** (`urllib`, `json`, `argparse`, `sqlite3` only if
  a tiny local buffer is used). No `cryptography`, no DB driver, no third-party deps.
  `from __future__ import annotations`; **no `X|Y` unions**; **no `match`**.
- **Package layout** (`sawa/`): `config`, `http`, `sawa_read`, `kalshi_read`, `discover`,
  `create_stub`, `analyze`, `cli`. (Not yet built — built per the Build Sequence below.)
- **Tests:** `python -m pytest tests/ -v`. Single test:
  `python -m pytest tests/test_discover.py::test_name -v`.

**CLI (read-only except the pure-local stub):**
```
python -m sawa.cli markets [--venue sawa|kalshi|all] [--search KW] [--category C] [--limit N] [--json]
python -m sawa.cli show    --venue sawa|kalshi (--id <predId> | --ticker <T>) [--json]
python -m sawa.cli create  --question "..." --outcomes "YES,NO" [--league L] [--json]   # STUB — not created
python -m sawa.cli suggest [--messages -|<file>] [--json]                               # one-shot payload for the agent
```

**Environment** (keep in `~/.sawa/env`, `chmod 600`, never committed):
- `SAWA_SUPABASE_URL` — `https://vmuuxsjafmkcdrcxouot.supabase.co`
- `SAWA_SUPABASE_KEY` — the existing key, used **GET-only** (accepted risk)
- `SAWA_KALSHI_ENV` — `demo|prod` (use `prod` for real Kalshi data; `demo` is empty)
- `SAWA_CACHE_DIR` (optional, default `~/.sawa/cache`) — local Kalshi series/event/market
  read cache (`cache.py`). Safe to delete; warm with `sawa warm`. Series/event indexes are
  **stale-while-revalidate**: interactive searches serve the on-disk copy even past TTL and
  never block on a cold rebuild (only a truly-empty cache fetches inline); `sawa warm` (cron,
  `refresh=True`) refreshes off the critical path — this is what keeps `/search` from timing
  out behind a multi-minute cold build.
- `SAWA_MARKET_URL_TEMPLATE` (optional, non-secret, e.g. `https://<domain>/market/{id}`) —
  builds tappable Sawa market-page links; unset → Sawa markets carry no url. Kalshi links are
  always built from the ticker.

---

## 5. Architecture + module contracts

```
Telegram group ⇄ OpenClaw (gpt-5.5-mini, device)
   │  /command or @bokchoy
   ▼
 sawa CLI (Python 3.9, stdlib, --json)
   │   READ-ONLY BY CONSTRUCTION (only GET requests; no write codepath exists)
   ├─ markets/search/show ─┬─ GET PostgREST  (Supabase, existing key, public markets only)
   │                       └─ GET Kalshi public API (no auth)
   ├─ create  → STUB (pure local echo; never touches any network/DB)
   └─ suggest → emits {markets snapshot + chat messages} as JSON for the AGENT to reason over
```

**Module contracts:**
```
sawa/config.py
  get_config() -> Config(supabase_url, supabase_key, kalshi_base)
    reads SAWA_SUPABASE_URL / SAWA_SUPABASE_KEY / SAWA_KALSHI_ENV(demo|prod→base url);
    raises ConfigError (exit 4) with a clear message if a needed var is missing.

sawa/http.py            # tiny stdlib GET helper (urllib), JSON parse, timeout, status→typed error
  get_json(url, headers={}, timeout=10) -> dict|list    # GET ONLY; no POST/PATCH/DELETE in module

sawa/sawa_read.py       # Supabase PostgREST, GET-only
  list_markets(cfg, *, search=None, category=None, limit=20) -> list[Market]
  get_market(cfg, pred_id) -> MarketDetail|None
    GET /rest/v1/Prediction?select=<safe cols>,Option(*)&isPrivate=eq.false&isHidden=eq.false
       &resolved=eq.false&order=createdAt.desc&limit=N  (+ optional ilike search)
    headers: apikey + Authorization: Bearer <key>; odds via latest OddsSnapshot per option.

sawa/kalshi_read.py     # Kalshi public API, GET-only
  list_markets(cfg, *, search=None, series=None, limit=20) -> list[Market]
  get_market(cfg, ticker) -> MarketDetail|None
    series allowlist (config const) → GET /markets?series_ticker=...&status=open;
    client-side substring filter on title/subtitle/ticker; hard --limit cap.

sawa/discover.py        # venue-neutral types + fan-out/merge
  @dataclass Market: venue, ref, title, status, deadline, options:list[Outcome], activity
                     # ref = "sawa:<id>" | "kalshi:<TICKER>"
  @dataclass Outcome: label, odds_pct
  search(cfg, query, venues=("sawa","kalshi"), limit=20) -> list[Market]   # calls each reader, merges, labels

sawa/create_stub.py     # the ONLY write-shaped command — pure local, no I/O
  stub_create(question, outcomes, league=None) -> StubResult
    StubResult(created=False, stub=True, message="Not created — create lands in the order-engine
      phase (writes not wired yet).", would_create={question, outcomes, league})

sawa/analyze.py         # one-shot data provider for the agent (NO LLM call here)
  suggest_payload(cfg, messages) -> {market_snapshot:[Market…], messages:[…], guidance:"propose 1-3 NEW market ideas"}

sawa/cli.py             # argparse dispatch; --json on every command; REJECTS unknown flags
  --json envelope: {"ok":bool,"command":str,"data":...,"error":null|{"code":str,"message":str}}
  exit codes: 0 ok · 2 usage/unknown-flag · 3 upstream/network · 4 config missing
```

**Live schema read in Phase 1:**
- `Prediction` — `id,title,description,category,deadline,resolved,winningOptionId,leagueId,
  isPrivate,isHidden,createdAt`. Discover with `isPrivate=eq.false&isHidden=eq.false&resolved=eq.false`.
- `Option` — `id,label,predictionId` (outcomes; embed via PostgREST `select=...,Option(*)`).
- `OddsSnapshot` — `predictionId,optionId,percentage,createdAt`; **latest per option = current odds**.
- **PII guardrail:** `User` holds `email/phone/password/googleId` — never queried, never surfaced.

---

## 6. Build sequence — CRAWL → WALK → RUN (each independently runnable + verifiable)

```
CRAWL  (no live secrets needed)
  Build: config.py, http.py, kalshi_read.py, cli.py (markets --venue kalshi + --json + unknown-flag reject)
  Tests: test_kalshi_read (mocked HTTP: search filter, --limit cap, series allowlist, empty), test_cli
  VERIFY: SAWA_KALSHI_ENV=demo python -m sawa.cli markets --venue kalshi --search temperature --limit 5 --json
          returns markets; python -m pytest tests/ -v green.

WALK   (needs the existing Supabase key)
  Build: sawa_read.py (PostgREST GET-only), discover.py (Market/Outcome, merge), cli markets --venue sawa|all + show
  Tests: test_sawa_read (column select, isPrivate/isHidden filter, odds latest-pick, empty), test_discover
  VERIFY: python -m sawa.cli markets --venue sawa --limit 5 lists ONLY public markets (read-only);
          --venue all --search lakers merges both; pytest green.

RUN    (device + OpenClaw)
  Build: create_stub.py, analyze.py, skills/sawa/SKILL.md, deploy wiring
  Tests: test_create_stub (created=False/stub=True, no network call), analyze payload shape
  VERIFY: on device — /markets, /search lakers, /show, /create … (stub message), /suggest
          all work in a Telegram group via OpenClaw.
```

---

## 7. Test coverage (target: 100% of read-path branches)

```
[+] kalshi_read.list_markets   ├ search filter / --limit cap / allowlist / empty            test_kalshi_read
[+] kalshi_read.get_market     ├ found / not-found (None)                                    test_kalshi_read
[+] sawa_read.list_markets     ├ PostgREST parse / isPrivate+isHidden filter / odds          test_sawa_read
                               │   latest-pick / empty / network error→exit 3
[+] sawa_read.get_market       ├ found / None                                                test_sawa_read
[+] discover.search            ├ merge both / single venue / zero results / labels           test_discover
[+] create_stub.stub_create    ├ returns created=False, stub=True, NO I/O                     test_create_stub
[+] analyze.suggest_payload    ├ snapshot+messages shape, empty messages                      test_analyze
[+] cli dispatch               ├ --json envelope / unknown-flag exit 2 / config              test_cli
                               │   missing exit 4 / upstream error exit 3
[+] http.get_json              └ timeout / non-200 → typed error                              test_http
```
Framework: **pytest**. No E2E/eval needed Phase-1 (read-only; the only LLM use is agent
reasoning, and it's demo-labeled, not a graded output). A **static test** also asserts no
write-method strings exist in the source (read-only-by-construction guarantee).

---

## 8. OpenClaw skill + device deployment

**`skills/sawa/SKILL.md`** — YAML frontmatter `name`/`description`/**`triggers:`** + prose +
**one few-shot per command**.
- **`triggers:`** `/markets` `/search` `/show` `/create` `/suggest` `@bokchoy` `Sawa`.
- Each command → run CLI by absolute path `__SAWA_BIN__` with `--json`; parse the envelope;
  reply into the group.
- **`/create` reply** must state clearly: *nothing was created; this previews the flow (order
  engine is a later phase).*
- **`/suggest`:** the agent passes the last N visible group messages inline
  (`__SAWA_BIN__ suggest --messages -`), then reasons over the returned snapshot itself and
  posts 1-3 labeled "💡 suggestion (demo)".
- **No-PII rule** + **virtual "Sawa coins" framing** in every reply.

**Device wiring (manual, Phase 1):**
```bash
cd <repo-on-device>
pip3 install --user -e .                       # stdlib only, no build deps
SAWA_BIN="$(python3 -m site --user-base)/bin/sawa"; "$SAWA_BIN" --help   # preflight
openclaw approvals allowlist add --agent main "$SAWA_BIN"
openclaw approvals get | grep -q "$SAWA_BIN" && echo OK || echo "ALLOWLIST MISSING"
# Secrets (~/.sawa/env, chmod 600 — NEVER commit/log):
#   SAWA_SUPABASE_URL=https://vmuuxsjafmkcdrcxouot.supabase.co
#   SAWA_SUPABASE_KEY=<existing key>            # write-capable; CLI uses GET-only (accepted risk)
#   SAWA_KALSHI_ENV=demo
mkdir -p ~/.openclaw/workspace/skills/sawa
sed "s#__SAWA_BIN__#$SAWA_BIN#g" skills/sawa/SKILL.md > ~/.openclaw/workspace/skills/sawa/SKILL.md
# Add the bot to the group; BotFather /setcommands for the / menu.
```

---

## 9. Supabase MCP (read-only)

The source repo's `.mcp.json` registers a read-only Supabase MCP for schema inspection:
```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=vmuuxsjafmkcdrcxouot&read_only=true"
    }
  }
}
```
Use `mcp__supabase__*` tools (`list_tables`, `execute_sql` SELECTs) to inspect the live
schema. It needs `claude /mcp` auth per machine. The `read_only=true` flag is load-bearing —
keep it.

---

## 10. Out of scope (deferred to the order-engine phase)

- **Any write to Sawa** — create is a pure local stub; no app-repo access / unknown API yet.
- **Bets / order placement / payouts** — the order engine is the next phase.
- **Kalshi trading + real money + RSA signing** — Kalshi is read-only data; product stays virtual.
- **A real read-only Supabase role/grant/view** — no DB changes this phase; the write-capable
  key + read-only-by-construction is the Phase-1 mitigation.
- **Recurring cron, ingest hook, privacy-mode changes** — `/suggest` is one-shot, messages
  passed inline.

**What already exists (reuse, don't rebuild):** the Sawa economy/markets (Postgres — READ
only), the Kalshi public market API, OpenClaw native Telegram + exec + skills + `/setcommands`,
and the `WhatsAppInbound` inbound-channel pattern to mirror when the write phase lands.

---

## 11. Review status

| Review | Trigger | Status | Findings |
|--------|---------|--------|----------|
| CEO Review | `/plan-ceo-review` | CLEAR (SCOPE_REDUCTION) | premise→virtual (D1); cut to read-only discovery (D2/D3) |
| Eng Review | `/plan-eng-review` | CLEAR (PLAN) | 1 P0 resolved (read access → existing key, GET-only, no DB change); modular contracts + crawl/walk/run + test diagram; 0 critical gaps |
| Codex Review | `/codex review` | n/a | codex not installed |
| Design Review | `/plan-design-review` | — | n/a (Telegram text + bot menu) |
| DX Review | `/plan-devex-review` | — | not run |

- **UNRESOLVED:** 0. **Accepted risk:** write-capable key on device (mitigated by
  read-only-by-construction; proper read-only grant deferred).
- **VERDICT:** CEO + ENG CLEARED — modular, device-handoff-ready, read-only Phase-1 plan.

---

## Provenance

This document consolidates, verbatim in substance, three sources from the original repo at
`…/unboundedscaling/hackathon/openclawSawa/openclawSawa`:
- `docs/SAWA_PHASE1_PLAN.md` — the Phase 1 build plan / source of truth.
- `CLAUDE.md` — the Sawa sections (critical context, invariants, runtime & commands, Supabase MCP).
- `.mcp.json` — the read-only Supabase MCP registration.

No secrets are included — only environment-variable **names** are referenced, never values.
