# Conversational Search — reliability + matching fixes (implementation spec)

**Status:** ALL FIVE IMPLEMENTED. Issues **1–4** shipped 24-Jun; Issue **5 shipped 25-Jun, generalized into a
natural-language AGENT SETTINGS framework** (not just quips). Typecheck clean; `npm test` 141 green. Found
24-Jun during the first live LOCAL-mode group test. Each item has **symptom → evidence → root cause → fix →
acceptance**.

**What shipped (1–4):** `max_tokens 80→256` + defensive JSON extraction (fences/prose/first-`{`-to-last-`}`)
in `classifyWithLlm`; `look for`/`search for`/`find me`/`look up for` added to the regex `SEARCH_TRIGGERS`;
pmxt timeout `6s→9s` + one transient-only retry (abort/network, never an HTTP status) with a class-aware
warn log; and proper-noun **entity decomposition** in `expandQueries` (words → adjacent bigrams → whole
span, capped at 6) made safe by scoring external rows against the **ORIGINAL** query (new `relevanceQuery`
arg on `searchVenue`) so the `RELEVANCE_MIN` floor drops decomposition noise. Plus a sharper cold
`SYSTEM_PROMPT` (entity+prop extraction, few-shot). See the per-issue ✅ notes below.

**Context.** The folk-style conversational SEARCH reply ([`src/sawa/cards.ts`](../src/sawa/cards.ts) `renderOne`)
+ history-aware follow-ups ([`src/sawa/conversation.ts`](../src/sawa/conversation.ts)) are live in iMessage
(LOCAL mode; see [`PROGRESS.md`](PROGRESS.md)). A live group test surfaced four reliability/matching bugs in
the search path plus one UX gap. Evidence below is from the bot's headless logs and a direct probe of the
real intent-LLM + pmxt (`gemini-3.1-flash-lite`, `api.pmxt.dev`) on 24-Jun.

---

## Issue 1 — Intent LLM returns truncated JSON → silent regex fallback ✅ DONE

**Symptom.** Log: `[intent] LLM classify failed — using regex gate. Unterminated string in JSON at position
184 (line 11 column 23)`. Intermittent; degrades intent quality (see Issue 2).

**Evidence.** Probe of `gemini-3.1-flash-lite` returns **multi-line, pretty-printed** JSON, e.g.
`{\n  "kind": "search",\n  "query": "Mexico Czechia Raul Jimenez player props"\n}` (77 chars, `finish=stop`).
The failing log case was an **11-line** body (~184 chars) — a verbose response that exceeded the token cap and
was cut off mid-string, so `JSON.parse` threw.

**Root cause.** `classifyWithLlm` ([`src/sawa/intent.ts`](../src/sawa/intent.ts), the
`chat.completions.create` call) uses **`max_tokens: 80`**. The model's occasional verbose/pretty-printed JSON
exceeds 80 tokens → truncated → `Unterminated string` → the `catch` falls back to the regex gate
(`via: "fallback"`). Parsing is otherwise unguarded against fences/prose.

**Fix** (`src/sawa/intent.ts`, `classifyWithLlm`):
- Raise `max_tokens` **80 → 256** (the schema is tiny; this removes truncation for any reasonable body).
- Before `JSON.parse(content)`, **extract the JSON object defensively**: trim, strip ```` ```json ```` /
  ```` ``` ```` code fences if present, and take the substring from the first `{` to the last `}`. Parse that.
- On parse failure, log the raw body (truncated) at `warn` so future regressions are diagnosable, then keep the
  existing fallback (never throw).

**Acceptance.** A unit test feeds `classifyWithLlm` (via the existing `__setClient` stub) a multi-line JSON
body, a code-fenced body, and a body with leading prose — all parse to the correct intent. The stubbed
`create` call is asserted to be invoked with `max_tokens: 256`.

---

## Issue 2 — `"look for X"` is not a search trigger → always hits the LLM, then degrades on failure ✅ DONE

**Symptom.** `Sawa look for Czechia Mexico` → empty-state, while `Sawa look for Czechia` sometimes worked.
`look for player props on …` consistently empty.

**Evidence / root cause.** `SEARCH_TRIGGERS` ([`src/sawa/intent.ts:74`](../src/sawa/intent.ts)) contains
`look up` but **not `look for`**:
`/^(find|search|lookup|look up|show me|show|get me)\b/i`. So `"look for X"` fails the regex gate, is marked
non-confident, and routes to the LLM. When the LLM fails (Issue 1), `parseIntent` falls back to the gate's
guess, whose `cleanQuery` does **not** strip `"look for"` → the query becomes `"look for czechia mexico"`,
which matches no market title → empty-state. (When the LLM succeeds it correctly strips `"look for"`, hence the
inconsistency.)

**Fix** (`src/sawa/intent.ts`):
- Add `look for`, `search for`, `find me`, and `look up for` to the first `SEARCH_TRIGGERS` entry's `re` and
  `strip` (alongside `find|search|lookup|look up|show me|show|get me`), so these phrasings resolve
  **deterministically at the regex gate** with the subject cleanly stripped — no LLM dependency.
- Verify the strip leaves the subject (`"look for Czechia Mexico"` → `"Czechia Mexico"`).

**Acceptance.** Unit tests: `classify("look for Czechia Mexico", "sawa")` → `{kind:"search", query:"Czechia
Mexico", confident:true, via:"regex"}`; same for `"search for X"`, `"find me X"`. Existing trigger tests stay
green.

---

## Issue 3 — pmxt `failed (error)` = 6-second timeout drops external venues ✅ DONE

**Symptom.** Log: `[pmxt] kalshi search "World Cup" failed (error) — degrading to without it.` (and Czechia /
Mexico Raul Jimenez …). Intermittent; silently loses Kalshi/Polymarket results, so a reply that should show an
external market shows fewer/none.

**Evidence.** `getJson` ([`src/pmxt/http.ts:28`](../src/pmxt/http.ts)) aborts at **`timeoutMs = 6_000`** via
`AbortController`; an abort throws a non-`PmxtError` (`AbortError`), which `searchExternal`
([`src/pmxt/discover.ts`](../src/pmxt/discover.ts)) logs as `(error)`. A direct probe shows pmxt normally
responds **<1s**, so these are transient slow responses under the live burst tripping the 6s ceiling.

**Fix** (`src/pmxt/http.ts` + `src/pmxt/discover.ts`):
- Bump the default `timeoutMs` **6_000 → 9_000**.
- Add **one retry** on a transient failure (`AbortError`/`TypeError` network error — NOT a `PmxtError` with a
  4xx/5xx status, which is a real "no result"/auth error and should not be retried) with a short backoff
  (~250ms). Keep the whole path fail-soft — a venue that still fails yields no rows and never blocks the reply.
- Distinguish the two in the warn log: `timeout`/`network` vs the HTTP status, so future logs aren't ambiguous.

**Acceptance.** A unit test (fetch stub) makes the first call reject with an `AbortError` and the retry resolve;
`searchVenue` returns the rows. A `PmxtError(429)` is NOT retried. Existing `runSearch` fail-soft tests stay
green.

---

## Issue 4 — Compound / player-prop queries miss markets that exist (the important one) ✅ DONE

**Symptom.** `look for player props on Mexico Raul Jimenez` → empty-state, even though a matching market
exists. `Czechia Mexico` → empty while `Czechia` → `Czechia vs Mexico Winner? — Mexico 44¢ (2.3×) on Kalshi`.

**Evidence.** Probe (single calls, no failure): `Raul Jimenez` → Kalshi **`Raul Jimenez: 1+ goals`** (5 rows);
`Mexico` → 5 rows; **but** `Mexico Raul Jimenez player props` → **0 rows** and `Czechia Mexico` → **0 rows**.
pmxt's `?q=` matches market **titles** by phrase, so a compound natural-language query never reaches the entity
that has a market.

**Root cause.** `expandQueries` ([`src/pmxt/discover.ts`](../src/pmxt/discover.ts)) only splits on **list
separators** (`/\s*(?:,|;|\/|&|\band\b)\s*/i`) and keeps the full query — it never decomposes a space-joined
compound (`"Mexico Raul Jimenez player props"`) into its entities. So the only sub-query searched is the full
phrase, which matches no title. The `RELEVANCE_MIN = 0.34` floor in `src/search.ts` *would* surface
`Raul Jimenez: 1+ goals` for the sub-query `"Raul Jimenez"` (token overlap ≈ 0.4) — the entity just never gets
searched.

**Fix** (most appropriate = deterministic expansion + a sharper LLM extraction, belt-and-suspenders):
- **(a) Entity sub-queries in `expandQueries`** — in addition to the full query + list-entities, also emit
  **proper-noun spans** (maximal runs of Capitalized words, e.g. `"Raul Jimenez"`, `"Mexico"`, `"Czechia"`) and,
  when a span has >1 word, the individual capitalized words too (`"Czechia Mexico"` → `"Czechia"`, `"Mexico"`).
  De-dupe; respect the existing `MAX_SUBQUERIES` cap (raise from 4 to ~6 if needed to fit full + 2–3 entities;
  bound it to protect the credit budget). Skip generic lowercase tails (`player props`, `goals`, `odds`).
- **(b) Sharper LLM extraction** — tighten `SYSTEM_PROMPT` ([`src/sawa/intent.ts`](../src/sawa/intent.ts)) so
  `"query"` is the **searchable entity + prop**, not the echoed phrase: e.g. `"look for player props on Mexico
  Raul Jimenez"` → `"Raul Jimenez goals"`; strip role words like `"player props on"`, `"odds for"`,
  team-context filler. Add 1–2 few-shot examples in the prompt. (This is best-effort; (a) is the deterministic
  safety net so it works even when the LLM is unavailable/fails.)
- Existing relevance ranking then surfaces the entity market; no change to `flattenRanked` needed.

**Acceptance.** Unit tests for `expandQueries`: `"Mexico Raul Jimenez player props"` includes `"Raul Jimenez"`
and `"Mexico"` (and the full); `"Czechia Mexico"` includes `"Czechia"` and `"Mexico"`; a single proper noun
(`"Czechia"`) is unchanged; the count never exceeds the cap. A `runSearch` test (fetch stub returning
`Raul Jimenez: 1+ goals` only for the `q=Raul Jimenez` call) proves the compound query surfaces that market.
**Live re-test:** `sawa look for player props on Raul Jimenez` → `Raul Jimenez: 1+ goals … on Kalshi.`

**Implementation note (as shipped).** The deterministic expansion emits, deduped + capped at 6:
individual capitalized words first (cheap, high-value), then adjacent capitalized **bigrams** (so a
3-word span like `"Mexico Raul Jimenez"` yields the real entity `"Raul Jimenez"`), then the whole
multi-word span. The linchpin that makes liberal decomposition **safe** is that `searchVenue` now takes a
`relevanceQuery` (defaulting to the fetch query); `searchExternal` passes the **original** user query, so a
row fetched via a broad sub-query (`"Cup"`) is scored against the full intent (`"FIFA World Cup"`) and the
existing `RELEVANCE_MIN = 0.34` floor drops the noise (`"Stanley Cup"` → 1/3 < floor) while keeping the
real market. Cached rows are re-scored on a cache hit (same fetch query, different original). Consequence:
`expandQueries("FIFA World Cup")` / `("Switzerland vs Canada")` now also emit their entity sub-queries
(the old "left unchanged" unit assertions were updated to the new intentional behavior) — the noise is
filtered downstream, not at expansion time.

---

## Issue 5 — Quips (`SAWA_FOLK_TONE`) are not user-editable; "turn on the quips" is swallowed into the search ✅ DONE (generalized)

**Shipped as a general settings framework, not a one-off.** Per owner direction ("it's more than just quips —
make other agent settings toggleable via natural language, the same way markets are searched"), Issue 5 was
implemented as an extensible **agent-settings** layer (`src/sawa/settings.ts`). **Full design doc:
[`AGENT_SETTINGS.md`](AGENT_SETTINGS.md).** Summary:

- **Registry of settings**, each owning its on/off NL phrasings + confirmation copy. Two ship today: **`quips`**
  (the `SAWA_FOLK_TONE` flourish — Issue 5 proper) and **`external`** (`"sawa only"` / `"all venues"` — drops
  pmxt enrichment for a Sawa-only reply). Adding a setting = one registry entry + one apply site.
- **Recognizer requires BOTH a subject AND a direction** (`classifySettingCommand`), so an incidental mention
  ("odds on a comedian's quips") is never a toggle — precision over recall, matching `NEXT_RE`'s philosophy.
- **Compound symptom fixed — Solution B** (the headline one the adversarial review flagged; the review framed
  it as A = standalone-only vs B = compound-aware, and we shipped **B**): `peelSettings` **strips the leading
  settings clause, applies the toggle, then re-runs intent on the remainder.** So `"turn on the quips, look
  for X"` applies the toggle and searches `"X"` — the toggle phrase is **never searched**. A head that isn't a
  settings command stops the peel, so `"find cap and trade"` / `"Switzerland, India"` never split.
- **Sticky per-space store** (`SpaceSettings`) — **DURABLE**: written through to a bot-local JSON file
  (`.sawa/settings.json`, gitignored; override `SAWA_SETTINGS_FILE`) on every change and rehydrated on
  startup, so a toggle **persists for days/weeks across restarts until changed again** — NOT in-memory-only.
  Spectrum has no server-side state on any tier, but the bot owns its host's filesystem; this is bot-local UX
  state, **not** a Sawa DB write (the no-writes invariant governs the Sawa Postgres / bot API, not a local
  preference file). **No TTL** (a preference must not revert mid-session); the env defaults (quips ←
  `SAWA_FOLK_TONE`, external ← pmxt-configured) only seed a never-set space. It does NOT live on
  `ConversationState` (which `onSearch` rebuilds every search) nor in the TTL'd `ConversationStore` — both
  would wipe the preference. Resolved at the two `nextTurn` call sites + the `runSearch` pmxt arg in
  `index.ts`. A **read** command (`"settings"`) reports the current per-space values.

Feasibility was identical for LOCAL mode (today) and a future builder/dedicated line — the feature is 100%
in-process (durability is a local file either way) and keys on the already-stable `space.id`; the builder plan
only makes group toggles reachable on a non-shared line. Tests: `tests/settings.test.ts` (recognizer on/off +
null, compound peel, store round-trip/independence/eviction, **durable persistence round-trip + legacy-key
tolerance**, read reply). 17 new tests.

### Original spec (retained for reference)

**Symptom.** `Sawa turn on the quips, look for player props …` searched the literal text
`"turn on the quips, look for player props …"` (→ empty). The folk-tone flourish can only be set via the
**`SAWA_FOLK_TONE` env var at startup**; there is no way to toggle it from chat.

**Requirement.** Make the quip tone **user-editable from chat**, persisted so it sticks across searches in a
conversation, defaulting to the `SAWA_FOLK_TONE` env value.

**Current plumbing.** `const folkTone = process.env.SAWA_FOLK_TONE …` in [`src/index.ts:155`](../src/index.ts)
is read once and passed as `{ folkTone }` into `nextTurn` → `renderOne`
([`RenderOneOptions.folkTone`](../src/sawa/cards.ts), [`folkQuip`](../src/sawa/cards.ts)).

**Fix** (new tiny feature; keep it small):
- **Intent.** Add a recognizer (regex, in the cold gate `classify` and/or `classifyFollowup`) for
  `quips on|off`, `turn on|off the quips`, `enable|disable quips`, `quips please` → a new `IntentKind`
  `"quips"` carrying `{ on: boolean }`. It must take precedence over `search` so the phrase isn't searched.
  Widen `IntentKind` to `"search" | "next" | "link" | "quips" | "other"`.
- **Per-space preference.** Quip preference must persist across searches, so it can't live in the per-search
  `ConversationState` (which `onSearch` resets). Add a small **sticky per-space preference**: either a separate
  `Map<spaceId, { folkTone: boolean }>` in [`src/sawa/conversation.ts`](../src/sawa/conversation.ts), or a
  `folkTone?: boolean` carried on a longer-lived per-space settings record. Default = the env `SAWA_FOLK_TONE`.
- **Wiring.** In [`src/index.ts`](../src/index.ts) `handleNatural`: on a `quips` intent, set the per-space
  preference and reply with a short confirmation (e.g. `Quips on.` / `Quips off.`). For every `search`/`next`
  reply, resolve `folkTone` from the **per-space preference** (falling back to the env default) instead of the
  global const, and pass it into `nextTurn`.
- Keep `SAWA_FOLK_TONE` as the **default** for new conversations.

**Acceptance.** Unit tests: the recognizer maps `"turn on the quips"`/`"quips off"` to `{kind:"quips", on:…}`
and does NOT classify them as `search`; the per-space preference round-trips and overrides the env default; a
reply after `quips on` includes the flourish, after `quips off` does not. **Live:** `sawa quips on` then
`sawa world cup` shows the flourish; `sawa quips off` removes it; the toggle phrase is never searched.

---

## Consolidated acceptance (for the `/goal`)

- [x] **1** `max_tokens: 256` + defensive JSON extraction; truncated/fenced/prose bodies no longer break intent.
- [x] **2** `look for` / `search for` / `find me` resolve at the regex gate with the subject stripped.
- [x] **3** pmxt timeout 9s + one retry on transient (abort/network) errors; HTTP-status errors not retried.
- [x] **4** `expandQueries` emits proper-noun entity sub-queries (capped); compound + player-prop queries surface
      the existing entity market (relevance vs the original query); sharper LLM extraction prompt.
- [x] **5** Chat-toggleable quips — shipped as a **general agent-settings framework** (`quips` + `external`,
      extensible), sticky per-space (no TTL), default from env; the toggle phrase is never searched, and a
      compound `"turn on the quips, look for X"` applies the toggle then searches the remainder. `"settings"`
      reads current values.
- [x] `npm run typecheck` clean; `npm test` green (141) with new unit tests for items 1–5.
- [ ] **Live group re-test** (pending hardware): World Cup (Sawa lead), `look for Czechia` (Kalshi),
      `look for player props on Raul Jimenez` (Kalshi goals market), `quips off`/`sawa only`/`settings`
      toggles, link follow-up.
- [x] Update [`PROGRESS.md`](PROGRESS.md) + [`AGENTS.md`](../AGENTS.md) status.

## Notes / out of scope
- pmxt remains **fail-soft and read-only**; never block the Sawa reply or trade. The disclaimer stays removed
  (owner decision; see `AGENTS.md`). The Sawa invariants (GET-only discovery, no DB writes) are unchanged.
- The imessage-kit group-send patch (mixed iMessage/RCS rooms) that made these live replies possible is a
  separate concern (`patches/@photon-ai+imessage-kit+3.0.0.patch`); see `PROGRESS.md`. Consider upstreaming to
  Photon (`npx patch-package @photon-ai/imessage-kit --create-issue`).
