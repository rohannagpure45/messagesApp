# Progress log

Reverse-chronological record of what shipped on the bot, why, and what's next. Authoritative
status lives in [`../AGENTS.md`](../AGENTS.md); the phased plan in [`BUILD_PLAN.md`](BUILD_PLAN.md).

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
