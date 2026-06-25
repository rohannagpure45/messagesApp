# Agent settings — natural-language toggles

**Status:** shipped (Issue 5, generalized). Code: [`src/sawa/settings.ts`](../src/sawa/settings.ts);
wired in [`src/index.ts`](../src/index.ts) `handleNatural`; tests in
[`tests/settings.test.ts`](../tests/settings.test.ts). This is the authoritative doc for the settings
framework — read it before touching `src/sawa/settings.ts`, the `handleNatural` settings block, or the
`folkTone` / pmxt resolution at the `nextTurn` / `runSearch` call sites.

The bot's behavior is **toggled by chat the same way markets are searched** — e.g. `sawa quips off`,
`sawa sawa only`, `sawa settings`. It is a small **extensible registry**, not a one-off quips flag: adding
a setting is one registry entry + one apply site.

## Current settings

| key | what it does | turn on | turn off |
|-----|--------------|---------|----------|
| `quips` | the `SAWA_FOLK_TONE` editorial flourish on replies | `quips on`, `turn on the quips`, `more banter` | `quips off`, `disable quips`, `no quips` |
| `external` | include Kalshi/Polymarket (pmxt) vs Sawa-only | `all venues`, `external on`, `include external markets` | `sawa only`, `external off`, `hide external markets` |

Plus a **read** command: `settings` / `show settings` / `what are your settings` → reports current
per-space values. `/help` advertises the toggles.

## The two seams

### 1. Regex-only recognizer (no new `IntentKind`)

Recognition lives entirely in `settings.ts` and runs in `handleNatural` **before** `parseIntent` — it is
**not** a new `IntentKind` in `intent.ts` (that path returns a single intent and can't cleanly model the
compound "toggle + search" case below; keeping it out also leaves the cold/follow-up intent gates
untouched). `classifySettingCommand(text)` requires **BOTH a setting subject AND an explicit direction
token** (on/off/enable/disable/…), so an incidental mention (`comedian quips odds`, a bare `kalshi` link
request) is never mistaken for a toggle. This is **precision over recall**, matching `NEXT_RE`'s philosophy
in `intent.ts`: a missed toggle just gets rephrased, but a false toggle silently changes behavior. OFF is
tested before ON because off-cues are the more specific phrasings.

### 2. Dedicated durable per-space store

`SpaceSettings` is a **dedicated** store — deliberately **NOT** a field on `ConversationState` (which
`onSearch` rebuilds from scratch every search → would wipe the preference) and **NOT** an entry in the
TTL'd/LRU'd `ConversationStore` (its 30-min TTL would silently revert a setting mid-session). It has **no
TTL**; a high LRU cap is only a runaway backstop. Keyed by `space.id` (stable per conversation in LOCAL and
cloud/builder modes alike).

## Solution B — compound handling (the documented Issue-5 symptom)

The original symptom (`SEARCH_FIXES.md` §5) was a **compound** message — `turn on the quips, look for X` —
being searched literally. The adversarial scoping review surfaced two options:

- **Solution A** — recognize only *standalone* toggle messages. Cheaper, but leaves the headline symptom
  (the compound) unfixed.
- **Solution B (chosen)** — handle the compound: **strip the leading settings clause, apply the toggle,
  then re-run intent classification on the remainder.**

`peelSettings(text)` implements Solution B: it walks the message clause-by-clause (splitting on `,`/`;`/
`and`/`then`/`&`), peeling **leading** clauses that are settings commands and accumulating them, until a
head is *not* a settings command — at which point it stops and returns that head + everything after as
`rest`. So:

- `turn on the quips, look for bitcoin` → `changes:[quips on]`, `rest:"look for bitcoin"` → toggle applied,
  remainder searched. The toggle phrase is **never searched**.
- `quips on, sawa only, world cup` → both toggles applied, `rest:"world cup"`.
- `find cap and trade` / `Switzerland, India` → the first head isn't a settings command, so the peel stops
  immediately and the **full** message is returned untouched (a real search is never split).

`handleNatural` applies the peeled `changes`, sends a confirmation, and — if `rest` is non-empty — continues
the normal flow (`parseIntent` → search/next/link) on the remainder.

## Durability — survives restarts (days/weeks)

Settings are **persisted to a bot-local JSON file** (`.sawa/settings.json` by default — already gitignored;
override with `SAWA_SETTINGS_FILE`) via the `SettingsPersistence` adapter. On every `set` the full snapshot
is written through (atomic temp-file + rename); on startup the file is rehydrated. So a toggle in a group
**sticks until changed again** — it does **not** revert to the env default on restart.

This is **bot-local UX state, not a Sawa write** — the no-writes invariant (`AGENTS.md`) governs the Sawa
Postgres and the bot API, not the bot's own preference file. Spectrum offers no server-side persistence on
any tier (shared, pro, or builder/dedicated line), but the bot owns its host's filesystem, so durability is
purely local and identical across LOCAL mode and a future builder line. The env defaults (`quips` ←
`SAWA_FOLK_TONE`, `external` ← whether pmxt is configured) only seed a space that has **never** been set.
Persistence is **fail-soft**: a read/write error degrades to in-memory and never crashes the bot. Tests
inject a fake in-memory `SettingsPersistence`, so the unit suite never touches disk.

## Adding a new setting

1. Add the key to `SettingKey` and a `SETTINGS` entry (label, on/off regexes, confirmation copy). Keep the
   recognizer **subject + direction** and the phrasings non-colliding with searches/venue link follow-ups.
2. Seed its env default where `SpaceSettings` is constructed in `index.ts`.
3. **Apply** it at the relevant reply site (e.g. `external` gates the pmxt arg to `runSearch`; `quips` sets
   `folkTone` at the `nextTurn` call sites). That's the whole change — the recognizer, peel, persistence,
   and read command pick it up automatically.
4. Add recognizer + store unit tests in `tests/settings.test.ts`.

## See also

- [`SEARCH_FIXES.md`](SEARCH_FIXES.md) §5 — the originating issue + acceptance.
- [`PROGRESS.md`](PROGRESS.md) — ship log.
