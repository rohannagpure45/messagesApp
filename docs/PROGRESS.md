# Progress log

Reverse-chronological record of what shipped on the bot, why, and what's next. Authoritative
status lives in [`../AGENTS.md`](../AGENTS.md); the phased plan in [`BUILD_PLAN.md`](BUILD_PLAN.md).

---

## 2026-06-24 — SEARCH live in iMessage; emoji-free card; group-ready

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
