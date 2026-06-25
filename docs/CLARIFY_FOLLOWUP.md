# Clarifying questions + hail-free follow-ups (implementation spec)

**Status:** IMPLEMENTED 2026-06-25. Typecheck clean; `npm test` **187** green (+31). Built from a live
iMessage DM session (the screenshots in the kickoff) that surfaced four problems; scoped with an owner
decision gate (3 questions) and an adversarial 4-lens review (11 confirmed findings, all addressed).

This is the authoritative design doc for the **ask-don't-guess** clarify flow and the **relaxed**
(hail-free) follow-up path. Read it before touching `src/sawa/clarify.ts`, the `pending` path in
`src/sawa/conversation.ts`, `refineClarify` in `src/sawa/intent.ts`, or the message loop / relaxation in
`src/index.ts` + `actionableWhenRelaxed` in `src/routing.ts`.

---

## The four problems (from the live DM)

1. **"find me a market on bitcoin" → an unrelated Sawa market** (*"Who will do the most damage at the
   market? Lily 86%, Dana 14%"*). The role-word "market" matched a title that merely contains it.
2. **Follow-ups failed without re-typing "sawa"** — "Send me the kalshi link" / "find a market on oil
   prices" with no hail got no reply (local mode requires a hail on every message).
3. **The intent LLM wasn't used to narrow the query before the pmxt call** — the regex gate produced a
   dirty query and short-circuited the LLM that would have cleaned it.
4. **An ambiguous topic should ask, not guess** — "bitcoin" / a player's many props should offer a
   choice (a native iMessage Poll), not silently pick one.

## Owner decisions (the gate)

- **Card UI:** native iMessage **Poll** + a numbered-text fallback — NOT the `customizedMiniApp`
  deep-link card (that needs a separately built+published iOS extension app, has no inbound selection
  event, and throws in local mode). Polls don't render in **local** iMessage, so the flow is
  platform-adaptive (poll on cloud/terminal, text list on local) and accepts a poll tap OR a text reply.
- **When to ask:** **only when genuinely ambiguous** — keep the snappy single-line answer for a clear
  winner; ask only when ≥2 distinct strong markets match.
- **Follow-up hail:** **relax within an active thread** — after one hail, follow-ups + clarify answers
  work hail-free for the conversation's 30-min TTL; cold/unrelated messages still need "sawa".

---

## Phase A — query→search precision (fixes #1, #3)

Three layers, all deterministic + unit-tested, so a barely-relevant Sawa row can never lead a real
external market again:

| Layer | File | Fix |
|---|---|---|
| Query cleaning | `src/sawa/intent.ts` `LEADING_ROLE_PHRASE_RE` in `cleanQuery` | `"find me a market on bitcoin"` → the first verb-trigger strips only `"find me"`, leaving `"a market on bitcoin"`; the role-phrase peel now yields **`"bitcoin"`** (also consumes a trailing article: `"a market on the election"` → `"election"`). |
| Relevance | `src/venue.ts` `QUERY_ROLE_WORDS` in `scoreRelevance` | Drops domain role-words (`market/odds/prediction/bet/wager/line/poll`) from the **query** side only, so `"market"` can't false-match `"…at the market"`. Title-side tokens are untouched. A query of *only* role-words scores 0 (accepted meta-query constraint). |
| Sawa-lead bias | `src/search.ts` `SAWA_MIN_LEAD_RELEVANCE = 0.5` in `pickLead` | The best Sawa match must itself clear 0.5 relevance before the `SAWA_LEAD_EPSILON` bias applies; below that, a clearly-relevant external market leads. |

"narrow the query before pmxt" (#3) is satisfied here (cleaning) + by the existing intent LLM gate; the
*ask-to-narrow* part is Phase B.

## Phase B — clarifying questions (#4)

**`src/sawa/clarify.ts`** (pure, presentation-neutral, 19 tests):
- `clusterTopics` — collapse the ranked candidates to one representative per **distinct topic** by
  pairwise title-token Jaccard ≥ `SAME_TOPIC_SIM` (0.5). One event's per-outcome slices ("…Brazil win?"
  / "…France win?", ~0.67 similar) collapse to one → World Cup still **answers directly** with the
  favorite; "bitcoin price" vs "bitcoin dominance" (~0.12) stay distinct → **ask**.
- `decideClarify(candidates, query)` → a `ClarifyQuestion` (≤4 options, each a real market) only when
  ≥2 strong (relevance ≥ 0.5) distinct topics survive; else `null` (answer directly).
- `resolveAnswer(question, raw)` → maps a poll tap (exact label) **or** free text ("2" / "second" /
  "the kalshi one" / a distinctive substring) to an option. **Precision over recall:** an ambiguous or
  non-matching answer returns `null` so the message falls through to a fresh intent.
- `renderClarifyText` — the numbered-list fallback for local/terminal.

**`src/sawa/intent.ts` `refineClarify`** — optional LLM pass (the "use the LLM more" piece): it can
**veto** a false-ambiguity (`ambiguous:false` when the titles are one market's outcomes → answer
directly) and **relabel** options to short natural phrases. Strictly fail-soft → the deterministic
question stands. This is the semantic backstop for cross-venue same-event phrasings that the
similarity heuristic alone might split.

**State** (`src/sawa/conversation.ts`): `ConversationState.pending` (the question) + `pendingBy` (the
asker's handle). `clarifyState(...)` builds it; `resolveClarifyTurn(...)` shows the chosen market,
points the cursor at it (so "another"/"send the link" continue), and clears `pending`/`pendingBy`.

**Wiring** (`src/index.ts`): `runConversationalSearch` decides clarify after the search; `sendClarify`
renders a `poll()` where supported (`pollCapable`) else a text list; `handlePollVote` resolves an
inbound `poll_option` (correlated by poll **title** — no poll id exists inbound); a pending text answer
resolves at the top of `handleNatural`.

## Phase C — hail-free follow-ups (#2)

`src/index.ts` message loop computes `relaxed = !hailed && convo.get(space.id) !== undefined` — a
non-hailed message is handled only when there's an active thread in that space. `actionableWhenRelaxed`
(`src/routing.ts`, pure + tested) then permits **only** a thread follow-up (`next`/`link`) or an
**explicit** search (a regex trigger, `via === "regex"`) — never a bare-topic guess or small talk, so
overheard inbox chatter stays silent. Settings toggles are skipped on the relaxed path.

---

## Safety: the hail invariant under relaxation

Local mode reads the **whole** Mac inbox, so the hail exists to stop the bot replying to messages not
meant for it. Relaxation preserves this:

- **Space-keyed:** only messages in the *same* space as an active thread are relaxed — the bot's other
  chats (different `space.id`) still require a hail.
- **Sender-bound clarify answers:** a pending clarify is bound to the asker (`pendingBy`); a bystander's
  unhailed "2" in a shared space (group / local inbox) is **not** their answer to give and is ignored —
  it leaves the question standing for the asker. (Poll *taps* are exempt: a tap on the bot's own poll
  bubble is an unambiguous, deliberate interaction, and polls never reach local mode anyway.)
- **Silent on non-actionable:** a relaxed message that isn't a follow-up / explicit search / valid
  answer gets **no** reply (not even the nudge).
- **Owner-tunable nuance:** in a *group*, any member's *explicit* search ("find oil") within the active
  thread's TTL is honored (the group has opted into the bot's presence). Tightening relaxation to the
  last asker only is a one-line change if desired.

## Adversarial review — what it caught (all addressed)

A 4-lens review (correctness / safety / Spectrum-API / edge-quality), each finding verified, confirmed
11 issues. The load-bearing fixes:

- **Clarify answer bypassed the hail gate / wasn't sender-aware** (critical+high) → **sender-binding**
  (`pendingBy`), so only the asker's text resolves their question.
- **`resolveClarifyTurn` showed `candidates[0]` instead of the tapped market** when the option wasn't in
  the current list (a stale poll after a new search) → show `option.result` directly.
- Test gaps closed: `resolveAnswer("0")`/filler, the `SAME_TOPIC_SIM` 0.5 boundary, role-word-pair
  queries, the stale-option `resolveClarifyTurn` path.
- Documented (no clean code fix without an inbound poll id): title-only poll correlation, a re-asked
  poll's stale tap being silently dropped, Spectrum's in-order delivery assumption.

## Acceptance

- `npm run typecheck` clean; `npm test` **187** green (clarify 19, conversation +4, intent +5, routing
  +3, venue +4, search +3).
- **Live to verify (owner):** in a cloud/terminal context — `sawa find a market on bitcoin` → a native
  **poll** of distinct bitcoin markets → tap one → that market's line; then `send the kalshi link`
  (no hail) works. In **local** iMessage — the same but as a numbered list, answered with "2". And the
  regression: `sawa find me a market on bitcoin` no longer returns the Lily/Dana market.

## Pointers

`src/sawa/clarify.ts` · `src/sawa/conversation.ts` (`pending`/`pendingBy`, `clarifyState`,
`resolveClarifyTurn`) · `src/sawa/intent.ts` (`cleanQuery`, `refineClarify`) · `src/venue.ts`
(`QUERY_ROLE_WORDS`) · `src/search.ts` (`SAWA_MIN_LEAD_RELEVANCE`) · `src/routing.ts`
(`actionableWhenRelaxed`) · `src/index.ts` (`runConversationalSearch`, `sendClarify`, `handlePollVote`,
the loop's `relaxed`). Spectrum poll facts: [`SPECTRUM_INTEGRATION.md`](SPECTRUM_INTEGRATION.md) §4.

---

# v2 — conversational rearrange (the first live group test)

The first live LOCAL-mode **group** test (owner + a second member) surfaced five gaps: the clarify
showed a **numbered list, not buttons**; some group members' handles arrived **empty** (`from=`) so
follow-ups felt clunky; **"what game is that for"** was mis-routed into a pmxt search; a "Lionel messi"
clarify offered **off-topic noise** ("Trump praise Messi"); and a **BTC 15-minute** market wasn't
surfaced. Owner decisions: keep the text list in local (buttons need a cloud/dedicated line — a
platform limit), and rearrange the flow so the LLM owns more of each turn and follow-ups key off the
**hailing sender**. `npm test` **196** green; typecheck clean. Built behind the baseline commit so it's
revertable.

**1. Per-sender sessions.** Conversation memory is keyed by `sessionKey(spaceId, senderId)` (was
per-space). Once a sender hails, **their** follow-ups + answers flow hail-free for the TTL; each member
keeps their own thread; one member's hail doesn't relax the space. Settings stay per-space.

**2. The `answer` action.** A new `IntentKind` `"answer"`: a question ABOUT the shown market ("what game
is that for", "what are the odds", "is that real money") gets a **grounded one-line reply** the LLM
writes from `cards.marketFacts` (title, headline odds, venue, money type, resolve date, link
availability) — instead of being mis-searched. Fail-soft to the regex gate. `marketFacts` **sanitizes**
the user-authored title before it enters the LLM context (prompt-injection defense).

**3. Cleaner clarify options.** `refineClarify`'s LLM contract is now `{ambiguous, options:[{n,label}]}`:
it **drops off-topic candidates** ("Trump praise Messi") and keeps the relevant ≤4. When it narrows to
exactly **one** relevant market, the caller shows THAT market (`conversation.pickedAnswer`) — never
`candidates[0]`, which could be the noise the filter just rejected.

**4. Sharper search.** The cold extraction prompt **drops a trailing timeframe** ("bitcoin 15 minutes" →
searches "bitcoin"), so the market family — incl. the 15-minute market — surfaces as a clarify option
instead of being dropped below the relevance floor. (Exact-qualifier matching is still bounded by pmxt's
index coverage.)

## v2 safety (adversarial-review-hardened, 2nd round)

A second 3-lens review confirmed 15 findings; the load-bearing fixes:

- **Unknown-handle senders are NEVER relaxed.** In local groups chat.db doesn't resolve every member, so
  they collapse to one per-space bucket; relaxing them would let an unhailed bystander ride another's
  session. They must hail each message (safe; no hail-free follow-ups for unresolved members).
- **Poll path now has the `pendingBy === senderId` guard** (symmetric with the text path).
- **`refineClarify` narrowing to <2 no longer shows the rejected noise** — it returns a 1-option question
  and the caller renders that market via `pickedAnswer`; `null` (→ top candidate) only when the model
  keeps nothing.
- **`marketFacts` sanitizes** user-authored titles/labels before the LLM context.
- Stale per-space docs/tests (the `ConversationStore` contract) updated to per-sender.

## Honest constraint — poll *buttons*

Native iMessage Poll **buttons** render only on a **cloud or dedicated** line; LOCAL mode (the free
group path) is text-only, so it shows the numbered list. The code already sends a real `poll()` where
the platform supports it (`pollCapable`). Getting buttons **and** reliable groups together needs a
dedicated Business line — deferred (owner decision).
