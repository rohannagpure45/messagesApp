# Progress log

Reverse-chronological record of what shipped on the bot, why, and what's next. Authoritative
status lives in [`../AGENTS.md`](../AGENTS.md); the phased plan in [`BUILD_PLAN.md`](BUILD_PLAN.md).

---

## 2026-06-26 — the 429 fix WAS the bug + LOCAL-DM follow-ups dropped (Issues 9–10)

A live DM/clarify test (the owner's "you created problems instead of solutions" report) plus a direct pmxt
probe exposed two more bugs — and corrected a mis-diagnosis from the 6–8 round. `npm test` **211** (+8);
typecheck clean. The LOCAL headless bot was restarted on the fix. Full detail in `docs/SEARCH_FIXES.md`
Issues 9–10.

1. **Transient header-less 429s were treated as definitive → false "couldn't reach (rate-limit)"**
   (`src/pmxt/http.ts`). The owner's pmxt dashboard showed **1–2 calls/min**, yet replies claimed a rate-limit.
   A probe was the smoking gun: at ~3 paced calls, `q="spaceX"` → **429 in 57 ms**, and the *very next* call
   `q="SpaceX"` → 200/20 rows; an 8-way burst → 2 instant 429s + 6×200, **no `Retry-After` on any**. So pmxt's
   free-tier 429 is a **fast transient burst/edge rejection that clears on the next call**, unrelated to the
   60/min budget — and the code's "a 429 is definitive, never retry" assumption was exactly backwards. Fix:
   `getJson` retries a **header-less** 429 (`PmxtError.retryable`, ≤2, short backoff; the single `reserveSlot`
   is reused so retries don't spend window budget); a `Retry-After` 429 stays non-retryable + arms the breaker;
   non-429 stays definitive; `PMXT_CONCURRENCY` 4→3. Verified live via the real `searchExternal`: spaceX (34),
   Haaland goals (25), Mbappé goals (13) all `errored=false`; SPCX / "spaceX stock price" → clean empty
   (`errored=false`), so the bot correctly offers to create rather than crying rate-limit.

2. **LOCAL-mode DM follow-ups / clarify answers silently dropped** (`src/routing.ts` + `src/index.ts`). The bot
   asked "Which 'spaceX' market? 1…4", the owner replied `"2"`, and it was **ignored** (`⊘ ignored … from=unknown`).
   The same DM sender arrives as `+16302101333` on some inbounds and `unknown` on others (chat.db `LEFT JOIN
   handle` doesn't resolve every row); the per-(space,sender) session key, the `pendingBy` binding, and the
   "unknown-never-relaxed" rule (correct for groups) **all** keyed on that flapping handle, so the `"2"` landed
   in a different bucket, failed the binding, and was refused relaxation — dropped three ways. (A latent NUL-byte
   separator in the old DM key surfaced during the fix too.) Fix: a DM binds its thread to the **space** via new
   pure helpers `threadOwner` / `sessionKey` / `canRelaxSender` (group behavior unchanged); `index.ts` threads
   `isGroup` through the handlers and keys `pendingBy`/relaxation by `threadOwner`. Also peels a trailing venue
   word that leaked into a query ("spaceX stock price kalshi" → "spaceX stock price").

---

## 2026-06-26 — accented-name empties + over-aggressive 429 pause (follow-on to 6–7)

A live DM test right after Issues 6–7 surfaced two more search-path bugs (`docs/SEARCH_FIXES.md` Issue 8).
`npm test` **203** (+2); typecheck clean.

1. **Accented names returned empty** (`src/pmxt/discover.ts` `PROPER_WORD`). `"Sawa Mbappé goals"` → *"No live
   markets … yet"* instantly, **no `[pmxt]` logs**. Root cause: `PROPER_WORD = /^[A-Z][\w''-]*$/` is ASCII-only,
   so `\w` excludes `é` → "Mbappé" failed the proper-noun test → was never decomposed into an entity sub-query.
   Since pmxt's `q` is a **substring title match**, only the full phrase `"Mbappé goals"` was searched, which
   matches no title (probe: `q="Mbappé"`→5 rows, `q="Mbappé goals"`→0), so it returned empty *with no error*
   (hence no log — calls succeeded). Fix: `/^\p{Lu}[\p{L}\p{N}''-]*$/u` (Unicode), so "Mbappé"/"Jiménez"/"Müller"
   decompose and reach their markets. ASCII names unchanged.
2. **A transient 429 blacked out the useful query** (`src/pmxt/http.ts` `noteServer429`). `"Haaland goals"` got a
   real but **transient** `HTTP 429` (residual minute-window from earlier bursts + the restart resetting our
   counter while the server's window persisted; the server probed `200` seconds later), and Issue 6's circuit
   breaker then imposed a **15 s default pause** that `rate-capped (local)` the stage-2 `"Haaland"` query — the
   one that returns 5 markets. Fix: pause **only on an explicit `Retry-After`** (capped 30 s); a header-less 429
   gets **no** pause, so a transient blip recovers on the very next call. The sliding-window cap (Issue 6) stays
   the standing backstop, so removing the fixed blackout doesn't re-open the storm risk.

**Diagnosis method (for the record):** the empty had **no `[pmxt]` log** → pmxt *succeeded* empty (logs fire only
on failure) → a matching miss, not a rate limit; a direct probe confirmed `q="Mbappé"`/`q="Haaland"` return rows
while the `… goals` phrase returns 0, and the regex test confirmed the ASCII/Unicode split. Bot restarted on the
fix; live re-test is the owner's step.

## 2026-06-26 — pmxt 429 client-side rate guard + Gemini follow-up off-schema hardening

A live group test (LOCAL mode) hit two distinct failures back-to-back: (1) **every** pmxt call returned
`HTTP 429` for a whole session — rapid testing by two members tripped the free-tier **60 req/min** ceiling, and
pmxt then 429s *everything* for the rest of the minute window (a direct probe with the same key returned `200`
seconds later, proving the markets exist and the key is fine); and (2) the intent LLM returned an off-schema
`{"error":"No market found for 'Haaland goals first half'…"}` when an *unrelated* new topic arrived while a
different market (Solana) was still the active-thread context injected into `FOLLOWUP_SYSTEM_PROMPT`. Both are
now fixed. `npm run typecheck` clean; `npm test` **201** (+5). Full spec: [`SEARCH_FIXES.md`](SEARCH_FIXES.md)
Issues 6–7.

1. **pmxt 429 storm — client-side rate guard** (`src/pmxt/http.ts` `getJson`/`reserveSlot`, `src/pmxt/discover.ts`).
   The staged fan-out + `PMXT_CONCURRENCY = 4` (commit `3741ddd`) bounded *concurrency*, not *rate* — 4 concurrent
   × ~1 s ≈ 240 req/min, ~4× over the ceiling. Added (a) a **sliding-window cap** of **55 / 60 s** that fail-soft
   **drops** the overflow (new `PmxtRateLimitError`, thrown before any network call) so we self-throttle and never
   trigger the server cooldown — a *drop*, not a queue, so a reply never hangs and the happy path (~2 calls) adds
   zero latency; and (b) a **`Retry-After` circuit breaker** that pauses every call after a real 429 until the
   header (or a 15 s default) elapses, so a burst stops hammering. A 429 is still **not retried** (consistent with
   Issue 3); the log distinguishes `rate-capped (local)` from a server `HTTP 429`. Also `CACHE_TTL_MS` 60 s→180 s.
   `MAX_SUBQUERIES` deliberately **kept at 6** — trimming it would drop the `"Raul Jimenez"` bigram Issue 4's
   decomposition needs. This closes the 25-Jun retest #2 deferral (*"pmxt HTTP 429 under a rapid manual burst …
   not addressed this round"*).
2. **Gemini follow-up off-schema `{error}`** (`src/sawa/intent.ts` `FOLLOWUP_SYSTEM_PROMPT`). The bot never asks
   the LLM whether a market exists — the `{error}` was a hallucination on a context mismatch (new topic vs the
   stale active-market context). The parser's `default→null` clamp already dropped it (fell back to a regex
   search, so it never reached the user), but it was wasteful/fragile. Hardened the prompt: no market data / never
   judge existence, never emit an `error` (or any non-schema) field, an unrelated/mismatched message →
   `kind:search`. Backstop clamp retained for defense in depth. See [`CLARIFY_FOLLOWUP.md`](CLARIFY_FOLLOWUP.md) §v3.

**Verification:** all 201 unit tests green incl. new pmxt rate-guard tests (cap drop + recovery, Retry-After pause,
default pause, per-slice fail-soft) and the off-schema `{error}` intent regression; the headless LOCAL bot was
restarted on the fix. Live burst re-test in iMessage is the owner's confirming step.

## 2026-06-25 — rich-link preview on the "send the link" follow-up

**Symptom (owner, from live use):** when the bot hands out a market link it shows differently on
LOCAL (Mac Messages.app) vs the CLOUD Business line, and there's no market image on the link.

**Root cause:** `renderLink` returned the URL *inside a sentence* (`"Here's the Kalshi one: https://…"`)
sent as one text/markdown bubble. iMessage only unfurls a URL into an Open Graph card (title + cover
image) when the URL is sent **alone** — a URL buried in surrounding text renders as a flat tappable
link. The cloud line (`sendText` + `enableDataDetection`) and Messages.app handle a buried URL
differently, which is exactly the "appears one way on local, another on cloud" report.

**Fix:** split the lead-in from the URL. The reducer's link turn now carries the target market in a new
`TurnOutcome.link` (URL kept OUT of `body`); `src/index.ts` `sendLink` sends the URL as its **own**
message — `richlink(url)` on a cloud/dedicated line (the provider sends a bare URL with link-preview
enabled → the destination's OG card), and a bare `text(url)` on LOCAL iMessage / terminal (Messages.app
unfurls a lone URL the same way; local supports only text + attachments, so `richlink` is avoided
there). The image is the destination page's `og:image` (Kalshi/Polymarket market pages carry one);
`richlink(url)` takes only a URL — Spectrum scrapes the cover, we can't inject our own — so an
attachment was deliberately NOT added (it would duplicate the unfurled image). Best-effort via `guard`.

**Verification:** `npm run typecheck` clean; `npm test` 196 green (reducer link tests now assert the
URL rides `outcome.link`, not `body`; a `next` turn carries no link). Live rich-card render needs a
cloud/dedicated line to confirm (owner step) — LOCAL shows the same card via Messages.app's own unfurl.

## 2026-06-25 — conversational rearrange (first live group test)

The first live LOCAL-mode GROUP test surfaced five gaps; the owner asked to rearrange the flow so the LLM
owns more of each turn and follow-ups key off the hailing SENDER (full spec
[`CLARIFY_FOLLOWUP.md`](CLARIFY_FOLLOWUP.md) §v2). Baseline committed first as a revert point. `npm test`
**196**; typecheck clean. Built + hardened across two adversarial review rounds (11 then 15 findings).

1. **Per-sender sessions** — conversation memory keyed by `sessionKey(spaceId, senderId)` (was per-space):
   the hailing sender's follow-ups/answers flow hail-free; each member keeps their own thread; settings
   stay per-space. UNKNOWN-handle senders (local groups where chat.db doesn't resolve a member) are never
   relaxed (they'd share a bucket) — they re-hail each message.
2. **`answer` action** — a question about the shown market ("what game is that for") gets a grounded
   one-line LLM reply from `cards.marketFacts`, instead of being mis-searched. `marketFacts` sanitizes the
   user-authored title (prompt-injection defense).
3. **Cleaner clarify** — `refineClarify` now drops off-topic options ("Trump praise Messi" for "Lionel
   messi"); narrowing to one relevant market shows THAT market (`pickedAnswer`), never `candidates[0]`.
4. **Sharper search** — the cold prompt drops a trailing timeframe ("bitcoin 15 minutes" → "bitcoin") so
   the market family surfaces as a clarify option (still bounded by pmxt index coverage).

**Honest constraint:** native poll BUTTONS render only on a cloud/dedicated line; LOCAL mode shows the
numbered text list. The code already sends a real poll where supported (`pollCapable`).

---

## 2026-06-25 — clarifying questions (ask-don't-guess) + hail-free follow-ups

From the first live iMessage DM session (the user bringing the bot up): four problems — (1) "find me a
market on bitcoin" returned an unrelated Sawa market ("…damage at the market? Lily/Dana"); (2) follow-ups
failed without re-typing "sawa" ("Send me the kalshi link", "find a market on oil prices"); (3) the intent
LLM wasn't narrowing the query before pmxt; (4) an ambiguous topic should *ask* (a poll), not guess. Scoped
with a 3-question owner gate and an adversarial 4-lens review. `npm test` **187** (+31); typecheck clean.
Full spec: [`CLARIFY_FOLLOWUP.md`](CLARIFY_FOLLOWUP.md).

1. **Phase A — query precision (the bitcoin/oil bug).** `cleanQuery` peels a residual `"a market on X"`
   role phrase → `"bitcoin"` (`src/sawa/intent.ts`); `scoreRelevance` drops domain role-words from the
   *query* side so `"market"` can't match `"…at the market"` (`src/venue.ts`); `pickLead` requires the best
   Sawa match to clear 0.5 relevance before the Sawa-lead bias applies (`src/search.ts`).
2. **Phase B — clarifying questions ("only when ambiguous").** New pure `src/sawa/clarify.ts`
   (`clusterTopics` collapses one event's per-outcome slices so World Cup still answers directly;
   `decideClarify`, `resolveAnswer`, `renderClarifyText`). A native iMessage **Poll** where supported
   (`pollCapable`), a numbered-text list on local iMessage; answers accepted from a `poll_option` tap OR a
   text reply, correlated to a `pending` clarify in conversation state. `refineClarify` (`src/sawa/intent.ts`)
   is an optional fail-soft LLM pass that vetoes a false-ambiguity and relabels options. NOT the
   `customizedMiniApp` deep-link card (needs a published iOS extension app; no inbound selection event).
3. **Phase C — hail-free follow-ups ("relax within an active thread").** The loop computes `relaxed`
   (no hail BUT an active thread in the space); `actionableWhenRelaxed` (`src/routing.ts`) permits only a
   follow-up or an *explicit* search, silent otherwise — so "send the kalshi link" / "find a market on X"
   work without re-hailing while inbox bystander chatter stays ignored.

**Safety (review-hardened):** clarify text answers are **sender-bound** (`pendingBy`) so a bystander's
unhailed "2" can't answer someone else's question in a shared/local-inbox space; `resolveClarifyTurn` shows
the tapped market directly (never `candidates[0]`) if it isn't in the current list. Space-keying keeps the
bot's other chats hail-gated. See [`CLARIFY_FOLLOWUP.md`](CLARIFY_FOLLOWUP.md) §Safety.

---

## 2026-06-25 (live group retest #2) — pmxt 429 root-caused; staged fan-out + graceful empty-state

A third live test reported "bitcoin returns nothing" and "wrong player-prop market/link". The headless log
showed the real cause: **every pmxt call in the session returned `HTTP 429`** — the entity-decomposition
fan-out (Fix 4) makes up to **12 calls per search** (6 sub-queries × 2 venues), and a burst of ~10 messages
blew past the free tier's 60 req/min. A direct probe confirmed bitcoin markets DO exist in pmxt (Kalshi
"Bitcoin price on Jun 21…", Polymarket "What price will Bitcoin hit in June…"), so the empties were purely
rate-limiting. `npm test` **156** (+5); typecheck clean.

1. **Staged fan-out** (`src/pmxt/discover.ts`): `searchExternal` now runs in two stages — the **full query**
   on both venues first (2 calls); the entity sub-queries fire **only if stage 1 found nothing**. Most
   queries ("bitcoin", "world cup", "argentina") resolve in stage 1, cutting the typical search from up to
   12 calls to **2**. (Bonus: decomposition noise like "Stanley Cup" off a "FIFA World Cup" search is never
   even fetched now.)
2. **Concurrency cap** (`PMXT_CONCURRENCY = 4`, `runLimited`): a fan-out can no longer fire all calls at once
   — the burst that trips pmxt's 429 is smoothed into a small queue.
3. **Graceful empty-state** (`src/search.ts` `externalErrored` → `src/sawa/cards.ts` `emptyReply`): when a
   pmxt lookup ERRORS (429/timeout) and nothing else matched, the reply now says *"Sawa has nothing on X, and
   I couldn't reach Kalshi or Polymarket just now (usually a brief rate-limit) — try again in a few seconds"*
   instead of the misleading *"No live markets for X"*. So a rate-limit no longer reads as "the market
   doesn't exist."

**Player-prop finding (investigated; not a code bug — a pmxt data/granularity limit):** the probe showed
pmxt's `url` is the **event page** (`kalshi.com/events/KX…`), with the specific market only in `slug`/ticker.
So the deep player-prop link the user wanted (`…/markets/…?op_market_ticker=…`) is **not in pmxt's data** —
we can only surface the event page. And a name search ("Tahith Chong") matches several props (score /
first-goalscorer / 2+ goals); ranking picks one, so narrowing the query is needed for a specific prop.
Deep-linking + prop-precision are deferred product calls (venue-specific URL construction).

---

## 2026-06-25 (live group retest) — recognizer robustness, LLM array JSON, recency ranking

A second live group test (3 members, mixed iMessage/RCS, LOCAL mode) surfaced three issues; all fixed.
`npm run typecheck` clean; `npm test` **151** (+8). Evidence came from the bot's headless log + a direct
pmxt probe.

1. **Settings recognizer was too rigid** — `turn up the quips`, `use more quips`, `turn on quips more`,
   `turn up the quips to do more` all fell through to search/nudge (log lines 49/51/55/67). **Rewrote**
   `classifySettingCommand` (`src/sawa/settings.ts`) from per-setting on/off regexes to a robust
   **subject + direction-token + short-clause** model: each setting declares only its SUBJECT; a shared
   `TURN_ON`/`TURN_OFF` vocab (on/up/more/enable… vs off/down/less/disable/only/no…) decides direction
   order-independently, so volume-metaphor and filler phrasings all resolve. Precision is held by a
   **`SEARCH_GUARD`** anchored at the clause start (a toggle never opens with `find`/`look for`/`odds on`/
   `is there a market` — so `is there a market on quips` stays a search; anchoring is also what lets
   `external markets on` toggle despite containing the substring "markets on"). `peelSettings` now also
   **strips a leftover leading conjunction** ("…, and look for X" → "look for X") and **peels a TRAILING
   toggle** ("find X, and turn up the quips" → applies the toggle, searches "find X").
2. **Intent LLM returned a JSON *array*** — `body=[` (log lines 28/56): gemini-flash-lite intermittently
   emits `[ {…} ]` despite json_object mode, which the Issue-1 object-slice couldn't parse → silent
   regex-gate fallback that then literal-searched compounds. `parseLlmJson` (`src/sawa/intent.ts`) is now
   **array-aware** (narrows to the first JSON value, unwraps an array to its first object); both prompts
   say "Return a SINGLE JSON object, never an array."
3. **Ranking ignored recency** — `look for Argentina` surfaced "Argentina vs Austria" (resolves 2026-07-06,
   vol ≈ 31M) over the imminent "Jordan vs Argentina" (06-27 game, vol ≈ 207k); the pmxt probe confirmed
   Austria won purely on the volume tiebreak. pmxt exposes **`resolutionDate`**, now read into
   `VenueResult.closesAt` (Sawa `deadline` too). A shared `compareResults` comparator (`src/search.ts`,
   injectable clock) ranks **relevance → recency (upcoming-soonest first, undated neutral, already-resolved
   last) → interest → volume**, used by both `rankAndCap` and `flattenRanked`. Date-less markets are
   unaffected, so prior behavior/tests are unchanged; Sawa-led topic queries still lead via the Sawa-epsilon
   bias.

**Deferred (owner docket):** not requiring a `sawa` hail on every follow-up — that is the LOCAL-mode safety
gate (the bot reads the whole inbox, so it must be addressed each time). **Noted:** pmxt `HTTP 429` under a
rapid manual burst (entity-decomposition fan-out × many messages) — fail-soft and self-healing in the 60s
window; not addressed this round.

---

## 2026-06-25 — Issue 5 shipped as a natural-language AGENT SETTINGS framework (quips + external; extensible)

The last open search-path item (chat-toggleable quips) shipped — **generalized**, per owner direction, into an
extensible **agent-settings** layer so other settings are toggleable by chat the same way markets are searched.
`npm run typecheck` clean; `npm test` **141** (+15). New module `src/sawa/settings.ts`.

- **Registry** (`SETTINGS`): each setting owns its on/off natural-language phrasings + confirmation copy. Two
  today — **`quips`** (the `SAWA_FOLK_TONE` flourish) and **`external`** (`"sawa only"` / `"all venues"` →
  drop pmxt enrichment for a Sawa-only reply). Adding one = a registry entry + an apply site.
- **Recognizer** (`classifySettingCommand`) requires BOTH a subject AND a direction, so an incidental mention
  ("comedian quips odds") is never a toggle. **`peelSettings`** strips LEADING settings clauses off a compound
  message (`"turn on the quips, look for X"`) and returns the remainder — applying the toggle and never
  searching it (closes the documented Issue-5 symptom the adversarial review flagged). A non-command head
  stops the peel, so `"find cap and trade"` / `"Switzerland, India"` never split.
- **Sticky per-space store** (`SpaceSettings`) — **DURABLE**: write-through to a bot-local JSON file
  (`.sawa/settings.json`, gitignored; override `SAWA_SETTINGS_FILE`) + rehydrate on startup, so a toggle
  **survives restarts for days/weeks until changed again** (Spectrum has no server-side state, but the bot
  owns its host's filesystem; this is bot-local UX state, NOT a Sawa DB write). **No TTL** (a preference must
  not revert mid-session); the env defaults (quips ← `SAWA_FOLK_TONE`, external ← pmxt-configured) only seed a
  never-set space. Deliberately NOT on `ConversationState` (rebuilt every search) nor the TTL'd
  `ConversationStore` — both would wipe it. Resolved per-space at the two `nextTurn` call sites + the
  `runSearch` pmxt arg in `index.ts`. A **read** command (`"settings"`) reports current values; `/help`
  advertises the toggles. Full design doc: [`AGENT_SETTINGS.md`](AGENT_SETTINGS.md).
- **Feasibility was identical for LOCAL (today) and a future builder/dedicated line** — 100% in-process,
  keyed on the already-stable `space.id`; the builder plan only makes group toggles reachable on a non-shared
  line, changing nothing about the design. Scoped via a 6-agent workflow (4 readers → synth → adversarial
  critic); the critic caught the compound-symptom gap, which this implementation closes.

**Still open:** a live iMessage group re-test of all five (search fixes + the new toggles).

---

## 2026-06-24 (search hardening) — 4 of 5 search-path issues fixed (intent JSON, triggers, pmxt retry, entity matching)

Implemented issues **1–4** of [`SEARCH_FIXES.md`](SEARCH_FIXES.md) (the work-list from the live group test).
Issue **5** (chat-toggleable quips) was scoped out as a feature, not a reliability bug — spec retained for a
follow-up. `npm run typecheck` clean; `npm test` **126/126** (+13 new unit tests).

1. **Intent LLM JSON truncation → fixed.** `classifyWithLlm` (`src/sawa/intent.ts`) raised `max_tokens`
   `80 → 256` and now extracts the JSON object defensively before `JSON.parse` (strips ```` ```json ````
   fences, narrows to first-`{`…last-`}`), logging the raw body on a parse miss before the regex fallback.
   The model's occasional multi-line/pretty-printed JSON no longer truncates into `Unterminated string`.
2. **`look for` / `search for` / `find me` triggers → added.** The first `SEARCH_TRIGGERS` entry now resolves
   these (plus `look up for`) at the zero-cost regex gate with the subject stripped (longest-first alternation
   so the bare verbs still work) — no LLM dependency, so an LLM hiccup can't degrade a `"look for …"` query.
3. **pmxt 6s timeout dropping venues → fixed.** `getJson` (`src/pmxt/http.ts`) default timeout `6s → 9s` plus
   **one** retry on a *transient* failure only (timeout `AbortError` / network `TypeError`) with a short
   backoff — an HTTP status (`PmxtError`, any 4xx/5xx) is definitive and never retried. The `discover.ts`
   warn log now distinguishes `timeout` / `network` / `HTTP <status>`. Stays fully fail-soft.
4. **Compound / player-prop queries missing existing markets → fixed (the important one).** `expandQueries`
   (`src/pmxt/discover.ts`) now decomposes a space-joined proper-noun compound into entity sub-queries
   (individual capitalized words → adjacent bigrams → the whole span, deduped, cap raised `4 → 6`), so
   `"Mexico Raul Jimenez player props"` reaches `"Raul Jimenez"` (which has a Kalshi `1+ goals` market) and
   `"Czechia Mexico"` reaches each country. The enabler: `searchVenue` takes a `relevanceQuery` and
   `searchExternal` passes the **original** query, so rows fetched via a broad sub-query are ranked against the
   user's full intent and the existing `RELEVANCE_MIN` floor drops decomposition noise (`"Stanley Cup"` from a
   `"Cup"` sub-query scores 1/3 < floor). The cold `SYSTEM_PROMPT` was also sharpened to extract the
   searchable entity+prop (with few-shot examples). Old `expandQueries` unit assertions for `"FIFA World Cup"`
   / `"Switzerland vs Canada"` were updated to the new (intentional) decomposed behavior.

**Still open:** Issue 5 (quips chat-toggle) and a live iMessage group re-test of the four fixes.

---

## 2026-06-24 (live group test) — LOCAL-mode group send fixed (mixed iMessage/RCS); 5 search issues spec'd

**The conversational reply now delivers live in an iMessage group** (LOCAL mode), and a 5-person test surfaced
five search-path issues to fix next.

**Group-send fix (shipped).** LOCAL-mode replies to the test group failed with AppleScript `-1728` (`Can't get
chat id "iMessage;+;chat419…"`). Root-caused via `chat.db`: the room is a **mixed iMessage + RCS conversation**,
and macOS Messages exposes only **one** AppleScript-addressable chat per conversation — the RCS one
(`RCS;+;chat419…`, which resolves and is sendable; this Mac's account already sends RCS there). imessage-kit
derived the reply target from the latest inbound's chat id (`iMessage;+;chat419…`), which Messages can't
resolve. **Fix:** patched `imessage-kit`'s group-send AppleScript (`buildSendScript`) to try the exact chat id,
then fall back to matching the `;+;<room-id>` suffix across `chats` and send to whatever Messages exposes
(`patches/@photon-ai+imessage-kit+3.0.0.patch`, now ck_chat_id + this). Validated read-only
(`iMessage;+;chat419… → RCS;+;chat419…`) and confirmed live (replies + the link follow-up delivered). Worth
upstreaming to Photon (`npx patch-package @photon-ai/imessage-kit --create-issue`).

**Five search issues found in the same test → spec in [`SEARCH_FIXES.md`](SEARCH_FIXES.md) (TODO, to be done via `/goal`):**
1. Intent LLM returns multi-line JSON truncated at `max_tokens: 80` → `Unterminated string` → silent regex fallback.
2. `"look for X"` isn't a `SEARCH_TRIGGER` (only `"look up"`) → routes to the LLM; on failure the bad query
   (`"look for …"`) degrades the search.
3. pmxt `failed (error)` = the 6s `AbortController` timeout firing under burst → external venues silently dropped.
4. Compound / player-prop queries miss markets that exist (`Mexico Raul Jimenez player props` → 0, but
   `Raul Jimenez` → `Raul Jimenez: 1+ goals` on Kalshi) — `expandQueries` never decomposes a space-joined
   compound into entities.
5. Quips (`SAWA_FOLK_TONE`) aren't user-editable — `"turn on the quips"` got swallowed into the search text;
   needs a chat toggle (sticky per-space, default the env value).

Full symptom→evidence→root-cause→fix→acceptance for each is in `SEARCH_FIXES.md`.

---

## 2026-06-24 (cont.) — Conversational redesign: card → single-market folk reply; disclaimer removed

**The verbose 3×3 cross-venue card (the entry below) was replaced with a folk-style, conversational
single-market reply + history-aware follow-ups** — modeled on the "folk" iMessage bot. The owner found
the card too text-heavy and chose to remove it entirely.

**What the bot does now:** "sawa <topic>" returns ONE natural line naming the favorite (+ a runner-up for
head-to-heads, e.g. `Ballon d'Or — Messi 93¢ (1.1×), Ronaldo 8¢ on Kalshi.`), with **no link until asked**.

1. **Per-conversation memory + follow-ups** (`src/sawa/conversation.ts`, new). An LRU+TTL
   `ConversationStore` (500 threads / 30 min, twin of `routing.ts` `SeenSet`) keyed by `space.id` stores
   the flat ranked candidate list + a cursor. A **pure `nextTurn(state, intent, results)` reducer** drives:
   - **"not that" / "another" / "more"** → pages to the next-best market across venues; "That's everything
     I've got…" at the end.
   - **"send the kalshi link" / "got a polymarket one?" / bare "kalshi"** → that venue's bare URL (cloud
     iMessage previews it natively); a graceful "I don't have a Kalshi market for that" when absent — never
     a fabricated link.
2. **History-aware intent** (`src/sawa/intent.ts`). `IntentKind` widened to `search | next | link | other`;
   a regex `classifyFollowup` (active-market only) runs before the cold gate; the LLM gets a one-line
   context digest to disambiguate the ambiguous middle ("what about kalshi"). Cold callers (no context)
   are byte-identical to before.
3. **Lead-venue logic** (`src/search.ts` `flattenRanked`). Sawa leads when it has a relevant market,
   unless an external market beats it on relevance by > `SAWA_LEAD_EPSILON` (0.2) — then best-relevance
   leads. `runnerUp` is carried through `VenueResult` for the folk two-sided line. `SAWA_FOLK_TONE=1`
   toggles a mild editorial flourish (off by default, factual otherwise).
4. **The 3×3 card was removed** (`renderSearch`/`searchBody`/`section`/`topSawaRichlinkUrl` deleted);
   `cards.ts` now holds `renderOne`/`renderLink`/`renderExhausted`/`renderNoVenue`. `/search` also uses the
   conversational reply.
5. **Disclaimer removed.** "Virtual Sawa coins — entertainment only, no cash value." was stripped from
   ALL output (conversational replies, `/markets`, HELP, the hello DM) per owner decision — relaxing the
   former "disclaimer on every coin/market message" invariant. Venues are still named inline and real-money
   prices read as real money, so lines stay unambiguous. Consent + virtual-coin framing is deferred to the
   future betting/money-action phase.

**Process:** design (3 independent architectures → synthesis) and an adversarial code review (4 dimensions
→ verify each finding) were run as multi-agent workflows; 2 confirmed bugs fixed with regression tests
(a `NEXT_RE` false-positive on "more info please"/"next election"; a `toPlainText` paren-URL truncation).

**Verification:** `npm run typecheck` clean; `npm test` **112/112** green (added `conversation.test.ts`;
extended cards/intent/search). **NOT yet re-verified live in iMessage** — the terminal TUI isn't reliably
drivable headless; cloud-iMessage re-verification is the open next step.

**Next:** dogfood the conversational flow live in iMessage (search → "not that" → "send the kalshi link");
the later phases still wait on the Sawa-app `/api/bot/*` Vercel deploy (see `AGENTS.md` deployment gate).

---

## 2026-06-24 — SEARCH live in iMessage; emoji-free card; group-ready

> **Superseded (same day):** the emoji-free 3×3 card described in item 2 below was replaced by the
> conversational single-market reply documented in the entry above. The card's live verification
> (multi-entity + topic queries) still holds for the *search logic*; only the *presentation* changed.

**SEARCH is verified working live in iMessage.** Two behaviors confirmed end-to-end:
- **Multi-entity queries** — "Switzerland, India" returns a full cross-venue card (Kalshi +
  Polymarket markets). (Root cause of the earlier empty result was fixed in `47c4d4f`:
  multi-entity queries like "Switzerland, India" tokenized in a way that returned no matches.)
- **Topic queries** — "Shark Tank" returns Sawa markets with a native rich-link cover card.

**This session's changes (all in the search/routing/presentation layer — no API surface change):**

1. **Removed every user-facing emoji.** The search card, the `/show` market detail, the on-boot
   hello DM, and the `/suggest` demo no longer emit `🪙 📈 🔎 📊 👋 💡`. Deliberately **kept**:
   - the `✋ ✅ ❌ ⟵ ⊘` glyphs in `console.*` (developer-only line-debug markers we rely on), and
   - the `👍 🙏 ❤️` inside `GREETING_RE` (`src/sawa/intent.ts`) — those match *inbound* user acks,
     so removing them would break greeting detection. They are never sent.

2. **Redesigned the search card (`src/sawa/cards.ts`).** Hierarchy now comes from **bold venue
   section headers + tappable links** instead of emoji — which is the right call because cloud
   iMessage renders markdown as native styled text (bold + links via UTF-16 formatting ranges,
   confirmed in `@spectrum-ts/core`). Shape:
   ```
   **Markets for "world cup"**

   **Sawa** — virtual coins
   Who will win the World Cup? — Brazil 59%  ·  open

   **Kalshi** — real money
   Who will win LA Mayor? — Karen Bass 65¢ (1.5×)  ·  open

   _Real-money prices are the cost of a $1 contract; ×N is the return if it hits.
   Sawa coins are virtual — entertainment only, no cash value._
   ```
   Now **one** markdown bubble + the rich-link cover (was: a separate lead bubble + body + cover).
   `RenderedSearch` dropped its `lead` field; `src/index.ts` `replySearch` updated to match.

3. **Group-chat readiness + identity normalization.** Mention-gating, group detection, and
   idempotency were already in place. Added `normalizeHandle()` (`src/routing.ts`) so the same
   human is keyed consistently whether the platform spells them as a phone (`(555) 123-4567` vs
   `+15551234567`) or an email-style Apple ID (case-folded). Used for the recent-message buffer
   key and inbound logging.

   **Known blocker (line model, not code):** reliable iMessage **group** chat needs a **dedicated
   (Business) line**. On the current free/pro **shared pool**, each end user is routed through a
   *different* pool number, so a group can't resolve to one coherent bot identity — this is the
   "both users allowed on the dashboard but on different numbers" symptom. The code is group-ready;
   the fix is a Photon plan/line upgrade. See [`IMESSAGE_TESTING.md`](IMESSAGE_TESTING.md) §2.

   **Group test (24-Jun) — CONFIRMED: shared-pool groups do not route inbound.** Two runs. Run 1 (group
   with the bot's 628 line + a 2nd member; "Sawa Switzerland India" / "Sawa bitcoin") logged no group
   `⟵ event`, but was **discarded** — the bot booted 11:59:17, the same minute, so the sends likely raced
   `listening` (the SDK streams live, not history → pre-connect messages are missed). Run 2 was clean: with
   the bot listening 28 min, a fresh group send (`sawa world cup`) again produced **zero group inbound**,
   while DMs to 628 in the same window *did* route (`⟵ inbound [iMessage/dm] from=+16093756850` for both
   "Sawa bitcoin" and "Sawa shark tank"). So group inbound is genuinely not delivered to a shared-pool
   line — matching the docs (*"shared mode cannot create group chats"*) and first principles. **A dedicated
   (Business) line is required for group chat.** Separately, both DM *replies* failed on Photon's send side
   with transient upstream errors (`SendTextMessage DEADLINE_EXCEEDED`, then `read ECONNRESET`): inbound is
   fine, outbound was flaky this session — a guarded send-retry is a candidate hardening (mind
   duplicate-on-timeout). Sender-handle `from=…` logging added to `src/index.ts` and kept.

**Verification:** `npm run typecheck` clean; `npm test` 78/78 green (card, routing, intent,
format, search, read, pmxt, read-only suites).

**Next:** decide the group-chat line (stay shared-pool best-effort vs. upgrade to Business);
then the unblocked future phases still wait on the Sawa-app `/api/bot/*` Vercel deploy (Create /
betting / analytics — see `AGENTS.md` deployment gate).
