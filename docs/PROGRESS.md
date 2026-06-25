# Progress log

Reverse-chronological record of what shipped on the bot, why, and what's next. Authoritative
status lives in [`../AGENTS.md`](../AGENTS.md); the phased plan in [`BUILD_PLAN.md`](BUILD_PLAN.md).

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
