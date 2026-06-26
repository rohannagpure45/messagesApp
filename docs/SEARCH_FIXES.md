# Conversational Search — reliability + matching fixes (implementation spec)

**Status:** ALL TWELVE IMPLEMENTED. Issues **1–4** shipped 24-Jun; Issue **5 shipped 25-Jun, generalized into a
natural-language AGENT SETTINGS framework** (not just quips). Issues **6–8 shipped 26-Jun** from later live
tests — a pmxt **429 storm** (client-side rate guard), a Gemini **follow-up off-schema `{error}`
hallucination** (prompt hardening), and **accented-name empties + an over-aggressive 429 pause** (Unicode
decomposition + a gentler circuit breaker). Issues **9–10 shipped 26-Jun** — **pmxt can't take concurrency**
(serialize: `PMXT_CONCURRENCY=1`, the real fix behind the false "couldn't reach" + 12s hangs) and **LOCAL-mode
DM follow-ups dropped** by sender-handle flapping (DM threads bind to the space). Issues **11–12 shipped 26-Jun**
from a live clarify/refine test — an **unhailed bare-topic refinement in a DM was silently dropped** (DM relaxed
mode now honors any search + a clarify-reply bypass), and **all-lowercase compound queries never reached their
entity** ("10 year treasury" → 0; `expandQueries` now decomposes lowercase content words). Issue **13 shipped
26-Jun** — **resolved/settled markets surfaced** (a finalized "BTC up in 15 mins?" at 100¢) and **"June"
decomposed into a copper market**: now filter resolved-status + decided real-money (≥97¢) markets, and exclude
month/weekday names from decomposition.
Typecheck clean; `npm test` 217 green. Each item has **symptom → evidence → root cause → fix → acceptance**.

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

## Issue 6 — pmxt `429` storm: rapid testing trips the free-tier per-minute ceiling, then pmxt 429s *everything* ✅ DONE

**Symptom.** During live group testing every external venue came back empty and the reply said *"couldn't reach
Kalshi or Polymarket just now"*. The headless log showed **`HTTP 429` on every pmxt call** — not the intermittent
single timeout of Issue 3, but a sustained wall of 429s across an entire session, including simple follow-up
queries that had markets.

**Evidence.** A direct probe with the SAME key returned `200 OK` with live data seconds later — so the key is
valid and the markets exist; the empties were purely rate-limiting. The free tier is **60 req/min**
([`PMXT_INTEGRATION.md`](PMXT_INTEGRATION.md) §2), and tripping it does **not** just fail the offending call —
pmxt then `429`s *every* request for the rest of the minute window, poisoning the key so the next legit search
is empty too. Two testers firing ~9 messages in ~2 min, several of them compound (each entity-decomposed into
up to 6 sub-queries × 2 venues), blew well past 60/min.

**Root cause.** The staged fan-out + `PMXT_CONCURRENCY = 4` cap (commit `3741ddd`) bound how many calls run **at
once**, not the request **rate** — 4 concurrent × ~1s each ≈ 240 req/min sustained, ~4× over the ceiling. There
was **no client-side rate limit**, and a `429` only degraded the current slice (it never told us to *stop
sending*), so a burst kept hammering the server straight through its cooldown. This is the deferred item the
25-Jun retest #2 log explicitly flagged (*"pmxt HTTP 429 under a rapid manual burst … not addressed this
round"*); Issue 6 closes it.

**Fix** (`src/pmxt/http.ts` + `src/pmxt/discover.ts`):
- **(a) Sliding-window cap (proactive).** A client-side guard in `getJson` (`reserveSlot`) caps outgoing calls at
  **55 / 60 s** — headroom under the 60/min ceiling — so we self-throttle and **never trip the server cooldown**.
  Overflow is **fail-soft dropped** (a new `PmxtRateLimitError`, thrown *before any network call*), so the search
  degrades to the graceful empty-state rather than blocking the reply. Deliberately a **drop, not a queue**: a
  chat reply must never hang waiting on a token, and the bucket starts full so normal use (~2 calls/search) adds
  **zero latency**.
- **(b) Retry-After circuit breaker (reactive).** If a `429` *does* come back (shared key, or the cap a hair
  generous), read its **`Retry-After`** header (or a 15 s default) and **pause every call until it elapses** — the
  direct antidote to the "429-everything-for-a-minute" storm. A `429` is still **NOT retried** (consistent with
  Issue 3's "an HTTP status is a definitive answer"); the pause prevents the *next* calls from hammering.
- **(c) Lighter footprint.** `CACHE_TTL_MS` **60 s → 180 s** (a re-asked topic — common in testing — reuses cached
  rows; discovery names a favorite, not a tradable quote, so slightly-staler odds are fine). `MAX_SUBQUERIES`
  **left at 6** — trimming it would drop the high-value proper-noun *bigram* (`"Raul Jimenez"`) that Issue 4's
  decomposition depends on, so the rate guard, not a fan-out cut, is what bounds the burst.
- New `PmxtRateLimitError` carries no HTTP status (no request was made); `searchSubqueries` classifies it in the
  warn log as `rate-capped (local)` to disambiguate a self-imposed skip from a real server `HTTP 429`.

**Acceptance.** `tests/pmxt.test.ts`: the guard lets 55 calls/min through then **fail-soft-drops the 56th with no
network hit**, and recovers when the window slides; a server `429` with `Retry-After: 30` **pauses subsequent
calls** (short-circuit, no fetch) until 30 s pass, with a 15 s default when the header is absent; a `429` on one
venue does **not** pre-empt a sibling call already in flight (per-slice fail-soft). Injectable clock
(`__setHttpClock`) + reset seam (`__resetRateGuard`) keep it deterministic. Issue 3's transient-retry test stays
green (a `429` is not swept into that path). **Extends, does not replace, `3741ddd`.**

---

## Issue 7 — Gemini follow-up hallucinates an off-schema `{"error"}` object on an unrelated new topic ✅ DONE

**Symptom.** After the bot showed a market (e.g. Solana), an *unrelated* new topic in the same thread
(`"Haaland goals first half"`) produced — from the intent LLM — `{"error":"No market found for 'Haaland goals
first half' on the specified venues."}`. The bot never asks the LLM whether a market exists, so this was a pure
hallucination.

**Evidence.** A captured `gemini-3.1-flash-lite` call shows the **active-market context** (`contextDigest`, the
Solana facts) injected into `FOLLOWUP_SYSTEM_PROMPT`, the user content `"Haaland goals first half"`, and the model
returning the off-schema `{error}` object (no `kind`). `interpretFollowupLlm`'s `default: return null` caught it
and `parseIntent` fell back to a regex search, so it **never reached the user** — but it wasted an LLM call and is
fragile.

**Root cause.** When the conversation has an active market, every follow-up message is classified with that
market's facts stapled into the system prompt (so `next`/`link`/`answer` follow-ups work hail-free). Given a
**context mismatch** — a brand-new topic while a *different* market is in context — flash-lite conflated "classify
this message" with "answer whether a market exists" and emitted an `error` escape hatch the prompt never forbade.

**Fix** (`src/sawa/intent.ts`, `FOLLOWUP_SYSTEM_PROMPT`):
- Append three clauses: **(a)** *"You have NO market data and CANNOT know whether any market exists — NEVER claim a
  market does or does not exist, NEVER refuse"*; **(b)** *"NEVER output an `error` field or any key other than
  kind/query/venue/reply"*; **(c)** *"If the message is UNRELATED to the shown market (a topic mismatch) or you are
  unsure it is a next/link/answer/other follow-up, classify it as `{"kind":"search"}` with the clean new topic in
  `query`."* The cold `SYSTEM_PROMPT` and all schema field names are untouched.
- Belt-and-suspenders: `interpretFollowupLlm`'s `default: return null` clamp (off-schema → regex-gate search)
  stays as the downstream backstop — defense in depth, so a stray hallucination still degrades to a search.

**Acceptance.** `tests/intent.test.ts`: with active-market `ctx`, an off-schema `{"error":"No market found…"}`
body (via the `__setClient` stub) yields `{kind:"search", query:"Haaland goals first half", via:"fallback"}` — the
hallucination is dropped and the topic is searched, never surfaced.

---

## Issue 8 — accented names return empty + a transient 429 blacks out the useful query ✅ DONE

**Symptom.** Two reports from a live DM test (after Issues 6–7 shipped): (a) `"Sawa Mbappé goals"` returned
*"No live markets for 'Mbappé goals' … yet"* **instantly, with no `[pmxt]` log lines** at all; (b)
`"Sawa haaland goals first half"` logged `HTTP 429` on `"Haaland goals"` then `rate-capped (local)` on
`"Haaland"` — *"when there was no actual rate limit."*

**Evidence.** A direct pmxt probe (all `200`, so the server is healthy): `q="Mbappé"`→**5 rows**
(`"…Kylian Mbappé have more goals…"`), `q="Mbappé goals"`→**0**; `q="Haaland"`→**5** (`"Erling Haaland: 1+
goals"`), `q="Haaland goals"`→**0**. And the regex test: `PROPER_WORD.test("Mbappé")` → **false** (ASCII),
**true** under a Unicode pattern. pmxt's `q` is a **substring/ILIKE title match**, so a multi-word phrase
("Mbappé goals", "Haaland goals") matches no title — only the bare entity does.

**Root cause.** **(a)** `PROPER_WORD = /^[A-Z][\w''-]*$/` ([`src/pmxt/discover.ts`](../src/pmxt/discover.ts)) is
ASCII-only (`\w` excludes `é`/`ü`/…), so an **accented name never decomposes** — `expandQueries("Mbappé goals")`
emitted only the full phrase, which matched nothing, and the bare `"Mbappé"` (which has markets) was never
searched → silent empty (no `[pmxt]` log because the phrase calls *succeeded* with 0 rows). **(b)** Issue 6's
**circuit breaker imposed a 15 s default pause on a header-less 429**; a *transient* 429 on the throwaway
phrase `"Haaland goals"` (which returns 0 anyway) opened that pause, which then **blocked the stage-2
`"Haaland"` query** — the one that would have returned 5 markets. The server had no sustained limit; the guard
over-reacted.

**Fix** (`src/pmxt/discover.ts` + `src/pmxt/http.ts`):
- **(a) Unicode-aware decomposition.** `PROPER_WORD` → `/^\p{Lu}[\p{L}\p{N}''-]*$/u`, so "Mbappé"/"Jiménez"/
  "Müller" decompose to the entity that actually has a market. Existing ASCII names are unchanged.
- **(b) Gentler circuit breaker.** `noteServer429` now pauses **only when the server sends an explicit
  `Retry-After`** (capped at `MAX_PAUSE_MS = 30 s`); a **header-less 429 gets NO pause** — it's treated as a
  transient blip so the next call (often the useful decomposed entity) recovers immediately. The sliding-window
  cap (Issue 6) remains the standing backstop against actually causing a storm, so dropping the fixed blackout
  doesn't re-open the 429-storm risk.

**Acceptance.** `tests/pmxt.test.ts`: `expandQueries("Mbappé goals")` contains `"Mbappé"` (and `Jiménez`/
`Müller` variants); `searchExternal("Mbappé goals")` surfaces the `"Kylian Mbappé: 2+ goals"` market via the
stage-2 entity; a header-less 429 does **not** pause — the very next call hits the wire and succeeds; an
explicit `Retry-After` still pauses (Issue 6 test retained). 203 green.

---

## Issue 9 — pmxt's transient header-less 429s are treated as definitive → false "couldn't reach" empties ✅ DONE

**Symptom.** A live DM/group test (after 6–8 shipped) still showed `[pmxt] … failed (HTTP 429)` and the reply
*"I couldn't reach Kalshi or Polymarket just now (usually a brief rate-limit)"* — but **the owner's pmxt
dashboard showed only 1–2 calls/min, never above 5.** A real 60/min limit was impossible; the 429s were
something else, and the prior round's rate-guard work had wrongly assumed they were budget exhaustion. (This is
the "you created problems instead of solutions" report.)

**Evidence.** A direct probe (paced ~3 calls, and an 8-way burst):
```
[kalshi] q="spaceX"  -> 429 in 57ms   count=-1      ← 429 in 57ms, at ~3 calls total
[kalshi] q="SpaceX"  -> 200 in 1467ms count=20      ← the very next call: fine
burst(8): 2 × "429 in ~137ms", 6 × "200"            ← NO Retry-After header on any 429
```
So pmxt's free-tier 429 is a **fast (~60 ms), transient burst/edge rejection that clears on the next call** and
carries **no `Retry-After`** — it is nothing to do with the 60/min budget. The code's core assumption — *"an
HTTP 429 is a definitive answer, never retry"* — was **exactly backwards for this provider.**

**Root cause.** `getJson` ([`src/pmxt/http.ts`](../src/pmxt/http.ts)) retried only `AbortError`/network errors
and threw **every** `PmxtError` immediately. So each transient 429 → fail-soft empty for that venue/sub-query →
`errored=true` → the false "rate-limit" empty-state (`cards.emptyReply`). At the owner's trivial call rate, the
*only* thing producing 429s was this transient edge — and we never retried it.

**Fix** (`src/pmxt/http.ts` + `src/pmxt/discover.ts`):
- **Retry a header-less 429.** `PmxtError` gains a `retryable` flag; a `429` **without** `Retry-After` is
  marked retryable and `getJson` retries it up to `MAX_RATE_RETRIES = 2` with a short backoff
  (`rate429BackoffMs`, 200 ms × attempt). A `429` **with** `Retry-After` stays non-retryable and arms the
  circuit breaker (unchanged). Any **non-429** 4xx/5xx is still definitive (never retried). The single
  `reserveSlot()` is reused across retries, so retrying does **not** consume extra sliding-window budget.
- **Lower the burst.** `PMXT_CONCURRENCY` 4→3 (the burst probe showed concurrency, not volume, is what trips
  the edge limiter). The sliding-window cap + `Retry-After` breaker from Issue 6 are retained as backstops.
- Wording: the rare *genuine* failure empty-state now reads "a brief hiccup on their end" instead of asserting
  a rate-limit (`cards.emptyReply`).

**Acceptance.** `tests/pmxt.test.ts`: a header-less 429 then OK → `searchVenue` retries and returns rows
(`n===2`); a *persistent* header-less 429 throws after exhausting the budget (`n===3`); a non-429 (500) is not
retried (`n===1`); the `Retry-After` pause test is retained. Verified live via the real `searchExternal`:
`"spaceX"`→34 rows, `"Haaland goals"`→25, `"Mbappé goals"`→13, `"spaceX stock price"`/`"SPCX"`→genuine empty —
**all `errored=false`** (the transient 429s are now retried away).

**⚠️ Follow-on (the retry alone was NOT enough — concurrency is the real culprit).** A second live test still
showed `failed (timeout)` and `failed (HTTP 429)`, and `"Sawa Messi goals"` came back "couldn't reach" on the
**first** try but found the market on the **second**. A head-to-head probe nailed it:
```
SEQUENTIAL (one at a time):   every call 200 in 130–450 ms, ZERO errors
CONCURRENT (10 at once):      ~20% of calls fast-429 OR HANG the full 12 s timeout; the rest 200
```
pmxt's free tier is fine serially but **chokes on concurrency** — some requests get a fast 429, others a *hung
connection* (the timeouts), which no retry can rescue. **Decisive fix:** `PMXT_CONCURRENCY` 3→**1** (fully
serial). The message loop already processes inbound messages one at a time, so serializing a single search's own
fan-out makes ALL pmxt traffic serial → fast + reliable. Stage 1 is now 2 sequential calls (~1 s); a rare
stage-2 decomposition is a few serial calls. Timeout also lowered 9s→**6s** (serial responses land <500 ms, so a
genuine hang fails fast and retries instead of stalling 9s). Re-verified live: 3 rapid back-to-back rounds of
`Messi goals`/`spcx`/`spaceX stock`/`Haaland goals first half`/`world cup` → **`errored=false` on all 15**, every
existing market found on the first try.

---

## Issue 10 — LOCAL-mode DM follow-ups / clarify answers silently dropped (sender handle flapping) ✅ DONE

**Symptom.** In a live DM the bot asked *"Which 'spaceX' market did you mean? 1… 2… 3… 4…"*, the owner replied
`"2"`, and it was **ignored**: `[sawa] ⊘ ignored [iMessage/dm] from=unknown — not addressed`. More broadly,
follow-ups in an active DM thread intermittently weren't tracked.

**Evidence.** The headless log shows the **same DM sender** arriving as `from=+16302101333` on some inbounds and
`from=unknown` on others (e.g. the `"2"`). In LOCAL mode the bot reads the Mac's `chat.db`, whose `LEFT JOIN
handle` does not resolve every inbound row, so `message.sender.id` is sometimes empty → normalized to
`"unknown"`. (A latent bug also surfaced during the fix: the old per-sender DM key held a literal **NUL byte**
separator, `` `${spaceId}\0${senderId}` ``.)

**Root cause.** Conversation memory was keyed **per (space, sender)** and the pending-clarify binding
(`pendingBy`) + the relaxation gate were all keyed on the *handle*. The clarify QUESTION was stored under the
sender's number; the `"2"` ANSWER arrived as `"unknown"` → a *different* session bucket, a `pendingBy`
mismatch, **and** the "unknown-handle senders are never relaxed" rule (correct for groups) refused to relax it
— so the answer was dropped three ways over. The per-sender key was introduced for *group* threads; a DM is 1:1
and never needed it.

**Fix** (`src/routing.ts` + `src/index.ts`): a DM's thread is bound to the **space**, not the flapping handle.
- New pure helpers in `routing.ts`: `threadOwner(spaceId, senderId, isGroup)` → `dm:${spaceId}` for a DM (so a
  pending clarify survives the handle flapping), the normalized handle for a group; `sessionKey(...)` wraps it;
  `canRelaxSender(senderId, isGroup)` → always `true` for a DM, `senderId !== "unknown"` for a group.
- `index.ts` threads `isGroup` through `runConversationalSearch` / `handleNatural` / `handleSlash` /
  `handlePollVote`; `pendingBy` is stored/checked as the `threadOwner` (DM → the space) so a DM answer resolves
  regardless of whether *that* inbound's handle resolved; `relaxed` uses `canRelaxSender`. Group behavior
  (per-member threads, unknown-never-relaxed, bystander can't answer another's clarify) is **unchanged**.

**Acceptance.** `tests/routing.test.ts`: `threadOwner`/`sessionKey` collapse a DM's `+1…` and `"unknown"` to the
**same** key; group keys stay per-sender and never collide with the DM key; `canRelaxSender` relaxes any DM
(incl. unknown handle) but only known group members.

**Cloud / business-line compatibility (asked explicitly).** The helpers carry **no local-vs-cloud branch** —
they take only `isGroup` + `space.id` + the normalized handle, all of which Spectrum delivers identically on
every provider (local, cloud shared pool, dedicated/business line). On a cloud/business line handles resolve
reliably (the chat.db flapping that motivated the fix doesn't occur), so: a cloud DM still binds to its stable
space and its clarify owner matches; a cloud/business GROUP gives each *resolved* member their own thread
(exactly what a business line is for) and only the asker can answer their own clarify (text or poll button).
Nothing here is gated on `SAWA_IMESSAGE_LOCAL`; the only local-mode branches in `index.ts` are orthogonal
(plaintext vs markdown, `richlink`/`poll` capability, and the local-only "hail everywhere" privacy rule). Locked
by `tests/routing.test.ts` › "cloud / business-line compatibility". 213 green.

---

## Issue 11 — an unhailed bare-topic REFINEMENT in a DM is silently dropped ✅ DONE

**Symptom.** After the bot asked a clarify, the owner replied (no "sawa") *"No I meant s&p price range today at
4pm"* — and the bot **said nothing**. The owner: *"it bounces from my number to unknown and doesn't respond to
my follow up… that is an error which should have been fixed."*

**Evidence.** The Issue-10 DM fix *did* work — the message now reaches `handleNatural` even with the flapped
`from=unknown` (`relaxed === true`). It dies one step later: the reply isn't a matching clarify option →
`pending` is cleared → `parseIntent` (no regex trigger) routes to the LLM, which returns
`{kind:"search", via:"llm"}` → the relaxed gate `actionableWhenRelaxed` only honored a `search` when
`via === "regex"` → **silent return.** So a bare-topic refinement in an active thread was dropped because it
wasn't an explicit regex trigger.

**Root cause.** The strict "relaxed search must be a regex trigger" rule exists to avoid acting on *overheard
group chatter*. But it was applied to DMs too, where it's wrong: a DM with an active session exists only because
the person deliberately hailed the bot, and **every message in a 1:1 thread is to the bot**. And a reply to a
clarify *we asked* is a direct answer, never overheard.

**Fix** (`src/routing.ts` + `src/index.ts`):
- `actionableWhenRelaxed(intent, isGroup)` now honors **any** `search` in a **DM** (`!isGroup || via==="regex"`);
  a **group** still requires the explicit regex trigger. `other` (greeting/small talk) is still ignored in both,
  so "ok"/"thanks" won't trigger a reply.
- A reply to a pending clarify the bot asked (`repliedToPending`) **bypasses** the gate entirely (DM *or* group)
  — the user is answering our own question, so the refined topic is searched.

**Acceptance.** `tests/routing.test.ts` › "actionableWhenRelaxed": a DM honors a `via:"llm"`/`"fallback"` search;
a group does not; `other` is silent in both. Verified live: the unhailed *"No I meant …"* refinement now replies.

---

## Issue 12 — all-lowercase compound queries never reach their entity ("10 year treasury" → 0) ✅ DONE

**Symptom.** Owner hypothesis: *"maybe it can not identify live markets on kalshi like the 10 year treasury or
15 minute bitcoin ones."* Indeed `"Sawa 10 year treasury"` → empty.

**Evidence.** A probe shows the markets **exist** — the *phrasing* misses them: `q="10 year treasury"` → **0**,
but `q="treasury"` → **20** ("…10-Year Treasury Yield…"), `q="10-year treasury yield"` → 14. pmxt's `q` is a
substring/ILIKE title match, so "10 **year** treasury" never matches "10-**Year** Treasury" (hyphen) or "30Y
Treasury". And `expandQueries` only decomposed **proper nouns** — an all-lowercase query ("10 year treasury")
produced no entity sub-query, so only the (missing) full phrase was searched.

**Root cause.** `expandQueries`'s decomposition was proper-noun-only (`PROPER_WORD`). Common entities are
lowercase nouns ("treasury", "inflation", "bitcoin"), which were never emitted.

**Fix** (`src/pmxt/discover.ts`): add a 4th decomposition step — **lowercase content words** (`contentWords`,
longest-first). It drops numbers/number-led units ("10", "4pm"), timeframe words ("year", "minutes", "today"),
pure market-framing/quantity words ("price", "range", "value", "level", "odds"), proper nouns (handled
separately) and <3-char tokens, leaving the salient entity. "10 year treasury" → `["10 year treasury",
"treasury"]`; "bitcoin price 15 minutes" → `["…", "bitcoin"]`. Stage 2 only runs when the full phrase found
nothing, and every row is scored against the **original** query, so the `RELEVANCE_MIN` floor keeps the on-topic
10-year market (1.0) and drops the 30Y one (0.33). Bounded by `MAX_SUBQUERIES` (proper-noun sub-queries, when
present, take the cap first — so existing player-prop decomposition is unchanged).

**Acceptance.** `tests/pmxt.test.ts`: `expandQueries("10 year treasury")` → `["10 year treasury", "treasury"]`;
framing/number/timeframe words dropped. Verified live via the full `runSearch` path: `"10 year treasury"` →
*"Will the yield of 10-year U.S. treasury notes be… 79¢ on Kalshi"*; `"cpi inflation rate"` → the CPI market —
both were empty before. (Genuine limit kept honest: `"s&p price range today at 4pm"` is a semantic gap — the
markets are framed "S&P above X at 4pm", which token-overlap can't reach from "price range" — but it now answers
cleanly instead of going silent; `"S&P 500"` finds them.) `npm test` 215 green.

---

## Issue 13 — resolved / settled markets surfaced; "June" decomposed → copper for a bitcoin query ✅ DONE

**Symptom.** A live "btc 15 min" session showed *"BTC price up in next 15 mins? — Target Price: $63,514.93 100¢
(1×) on Kalshi"* (a **settled** market — 100¢ = $1.00, already resolved). Then a clarify answered with a date
(*"June 26 2026, 1:30 pm cdt"*, which matched no option) returned a **copper** market for a bitcoin search. The
owner: *"live markets are having difficulty being tracked."*

**Evidence.** A raw-field probe of pmxt:
```
status=finalized  topPrice=0.999  "BTC price up in next 15 mins?"   ← RESOLVED, returned despite closed=false
status=active     topPrice=0.992  "BTC price up in next 15 mins?"   ← active but decided (near-1.0)
q="June" → "…Fed decision in June", "Drake #1…", "copper above 6.14 on June"   ← "June" matches any June market
```
So **(a)** pmxt returns `status=finalized` markets even with `closed=false`, and many intraday markets sit at
0.99–1.0 (settled) while still `status=active`; **(b)** `expandQueries` decomposed the capitalized month **"June"**
as a proper-noun entity, which substring-matched every market resolving in June (Fed/Drake/copper). (The link URL
was a red herring — pmxt returns the correct `/events/KXBTC15M-…`; "kalshi.com" is just Kalshi's weak OG preview.)

**Fix:**
- **Drop resolved markets** (`src/pmxt/discover.ts` `isResolvedStatus`): filter rows whose `status` is
  finalized/settled/resolved/closed/determined/inactive/expired/void/cancel(l)ed, before caching.
- **Drop decided real-money markets** (`src/search.ts` `isLiveDiscoverable`, in `rankAndCap`): a HARD filter on
  real-money favorites **≥ 0.97** (catches the active-but-near-1.0 intraday markets the status filter misses).
  Scoped deliberately: **Sawa is never price-filtered** (its read path already excludes resolved, and early pools
  are legitimately lopsided), and the **low side is not filtered** (a longshot is real discovery; a settled-NO
  binary is caught by the `status` filter).
- **Don't decompose month/weekday names** (`src/pmxt/discover.ts` `TIMEFRAME_PROPER`): a capitalized month or
  weekday breaks a proper-noun run, so "June 26 2026 1:30 pm cdt" no longer emits "June". The query now returns a
  clean empty instead of a copper market.

**Adversarial review (Workflow, 5 agents) — one blocker caught + hardening:**
- **`closed`/`inactive` are NOT resolved** (blocker, fixed): pmxt forwards each venue's RAW status string. Per
  Kalshi's lifecycle, `status=closed` = "past close_time, outcome UNKNOWN, awaiting determination" and
  `inactive` = "temporarily deactivated" — both are LIVE/pending. The first cut wrongly listed them, which would
  have dropped tradeable markets. Removed; a genuinely-settled near-1.0 `closed` market is still caught by the
  ≥97¢ price filter. Added the decided Kalshi states `disputed`/`amended` and Polymarket's `archived` (the list
  is a best-effort, venue-native denylist — extend as venues are added).
- **Lowercase month recurrence** (fixed): `TIMEFRAME_PROPER` only guarded the Capitalized proper-noun path; a
  *lowercase* "june"/"monday" still passed `contentWords`. Added month/weekday names to `DECOMP_STOPWORDS` too.
- **Deferred (known, narrow):** `searchExternal` decides stage-1-empty from the RAW row count, before
  `rankAndCap`'s ≥97¢ filter. So a stage-1 slice of *only* near-locks skips the stage-2 entity fan-out and then
  gets filtered to empty — a narrow over-filter window. Fix when next touching `searchExternal` (export
  `SETTLED_HI`/`isLiveDiscoverable` from `search.ts` and make the gate discoverability-aware).

**Acceptance.** `tests/pmxt.test.ts`: `searchVenue` drops `status=finalized`/`settled`/`disputed`/`archived` but
**keeps** `closed`/`inactive`/`active`; `expandQueries` never emits a month/weekday entity (Capitalized OR
lowercase). `tests/search.test.ts`: a ≥97¢ real-money near-lock is filtered while the competitive favorite leads
and a longshot is kept. Verified live: "btc 15 min" leads with a 45¢ competitive market (settled gone); "June 26
2026, 1:30 pm cdt" → clean empty (no copper); "england new zealand" still works. `npm test` 217 green.
**Inherent limit:** dated/recurring intraday markets ("Bitcoin price on Jun 19" at 90¢, resolving today) can
still appear — below the 0.97 bar and `resolutionDate` is future-ish, so not detectably stale; clarify
clustering collapses the near-identical ones.

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
- [x] **6** pmxt **429 storm** — client-side sliding-window cap (55/60 s, fail-soft drop) keeps us under the
      free-tier 60/min so the server cooldown never triggers; a `Retry-After` circuit breaker pauses calls after
      a real 429; cache TTL 60 s→180 s; `MAX_SUBQUERIES` left at 6 (trimming would break Issue 4's decomposition).
- [x] **7** Gemini **follow-up off-schema `{error}`** — `FOLLOWUP_SYSTEM_PROMPT` now forbids non-schema/`error`
      fields, declares the model has no market data / must never judge existence, and routes an
      unrelated/mismatched message to `kind:search`; the parser `default→null` backstop stays for defense in depth.
- [x] **8** **Accented names + transient-429 blackout** — `PROPER_WORD` is Unicode-aware so "Mbappé"/"Jiménez"
      decompose to the entity that has a market (pmxt `q` is a substring title match, so the full phrase misses);
      the circuit breaker pauses only on an explicit `Retry-After` (no 15 s default blackout), so a transient 429
      no longer kills the useful stage-2 entity query.
- [x] **9** **pmxt reliability — serialize + retry.** Verified live: pmxt's free tier is fast + error-free
      SERIALLY but ~20% fast-429/HANG under CONCURRENCY. Decisive fix: `PMXT_CONCURRENCY` 3→**1** (the message
      loop is already serial, so all pmxt traffic becomes serial → fast + reliable); plus `getJson` retries a
      header-less 429 (≤2, `retryable` flag), keeps `Retry-After`/non-429 definitive, and timeout 9s→6s. Kills
      the false "couldn't reach" empties + the 12s hangs at the owner's 1–2 calls/min.
- [x] **10** **LOCAL-mode DM follow-ups fixed** — DM threads bind to the space (`threadOwner`/`sessionKey`/
      `canRelaxSender` in `routing.ts`), immune to chat.db handle flapping; the `"2"` clarify answer and hail-free
      follow-ups now resolve in a DM even when the inbound's handle didn't resolve. Group behavior unchanged.
- [x] **11** **Unhailed DM refinement honored** — `actionableWhenRelaxed(intent, isGroup)`: a DM honors ANY
      search (not just regex), a group stays strict; a reply to a pending clarify bypasses the gate
      (`repliedToPending`). Fixes the silently-dropped "No I meant …" refinement.
- [x] **12** **Lowercase-compound recall** — `expandQueries` decomposes lowercase content words (`contentWords`),
      so "10 year treasury" → "treasury" etc. reach the entity (number/timeframe/framing words dropped;
      relevance-floored vs the original query). Verified live: treasury/CPI markets now surface.
- [x] **13** **No resolved/settled markets + no month decomposition** — `isResolvedStatus` (discover.ts) drops
      finalized/settled rows; `isLiveDiscoverable` (search.ts) hard-filters real-money favorites ≥97¢ (Sawa
      exempt, longshots kept); `TIMEFRAME_PROPER` excludes month/weekday names from decomposition (the
      copper-for-June bug). Verified live: "btc 15 min" leads with a competitive market, no copper.
- [x] `npm run typecheck` clean; `npm test` green (217) with new unit tests for items 1–13 (incl. cloud/business-line compatibility).
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
