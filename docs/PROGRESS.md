# Progress log

Reverse-chronological record of what shipped on the bot, why, and what's next. Authoritative
status lives in [`../AGENTS.md`](../AGENTS.md); the phased plan in [`BUILD_PLAN.md`](BUILD_PLAN.md).

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
