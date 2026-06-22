# Spectrum / iMessage integration & analytics reference

> Ground truth for how the bot reads the world: the **identifiers**, the **inbound events** (including
> **reactions / tapbacks**), what is **not** available, and how each maps into our analytics. Verified
> first-hand against `spectrum-ts@^4.2.0` in `node_modules/spectrum-ts/dist/*` (the `.d.ts` types and the
> compiled provider `chunk-NLMQ75LH.js`), cross-checked with the `spectrum` skill + photon.codes docs,
> on 2026-06-20. Citations are `file:line` under `node_modules/spectrum-ts/dist/`. Companion to
> [`BETTING_BOT_PLAN.md`](BETTING_BOT_PLAN.md).

---

## 1. The inbound stream is EXACTLY three events

The iMessage provider merges only these streams into `app.messages` (`chunk-NLMQ75LH.js:2413-2415`):

| Event | What it is | We use it for |
|---|---|---|
| **`message.received`** | a new inbound message (text, poll, attachment, …) | commands, NL intents, betting, analytics |
| **`message.reactionAdded`** | a **tapback** (👍 ❤️ 😂 ‼️ ❓ 👎) on a message | **engagement signal**, optional one-tap confirm, analytics (§3) |
| **`poll.changed`** | a tap-to-vote poll result | tap-to-bet, analytics |

**Everything else is dropped before it reaches the bot:** no `read` receipts, no `typing`, no
`presence`/online, no `delivered`, no `opened`/focus, no member join/leave/rename, no edit/unsend, **no
reaction-removed**. `read` and `typing` exist in the SDK only as **outbound** content the bot *sends*
(`types-CyfLJXgu.d.ts:838-850, 903-909`), never as inbound signals.

**Consequence:** there is **no "app opened / user is active" event and there never will be on iMessage.**
Proactive suggestions therefore must be **reply-driven** (respond while the topic is live), not pushed.
The only inbound "the user did something deliberate" signals are an inbound message, a tapback, or a
poll vote — and of those, **tapbacks are the highest-signal, lowest-friction engagement event.**

---

## 2. Identifiers

From the public `Message` interface (`types-CyfLJXgu.d.ts:880-923`):

| Field | Type / source | Notes & use |
|---|---|---|
| `message.id` | `readonly string` (`:884`) | On remote iMessage this **is the Apple message GUID** (`chunk:900,951`). **Our idempotency + analytics dedup key.** No separate `guid`/`createdAt` field exists. |
| `message.timestamp` | `Date` (`:914`) | event time → `BotEvent.occurredAt`. |
| `message.direction` | `"inbound" \| "outbound"` (`:882`) | gate on `inbound`. |
| `message.sender` | `User \| undefined` (`:912`) | **null-check.** |
| `message.sender.id` | `string` (`User { id, __platform }`, `:754-758`) | iMessage = participant's **canonical address: E.164 phone OR Apple-ID email** (`chunk:770` `resolveSenderId = m => m.sender?.address ?? ""`). Present in **DMs and groups**. iMessage `userSchema` is **empty** (`providers/imessage/index.d.ts:123`) — `sender.id` is all you get per person. |
| `message.space.id` | `string` (`:837`) | chat GUID; conversation/group key. DM GUIDs embed the participant address. |
| `message.space` (iMessage) | `{ id, type: "dm"\|"group", phone }` (`providers/imessage/index.d.ts:124-131`) | `type` = group/DM discriminator; `phone` = routing **line** (stable on Business/dedicated). |
| `message.platform` | `string` (`:885`) | `"iMessage"` (capital M) / `"terminal"`. **Analytics:** `POST /api/bot/events` accepts only the lowercase literal `"imessage"` (case-sensitive `PLATFORMS` whitelist) — the client must **lowercase it** before sending or the event is rejected `invalid platform`; `terminal` is not an accepted analytics platform. |

**Synthetic but stable ids:** multipart messages explode into a `group` with child ids
`p:<index>/<parentGuid>` (`chunk:623`); reactions get `${messageGuid}:reaction:${sequence}`
(`chunk:1075`). Both are valid, stable dedup keys.

**iMessage extras (via narrowing):** `partIndex`, `parentId` on the message
(`providers/imessage/index.d.ts:132-136`); an `isFromMe` flag on the raw message schema.

**Correlation (no standalone ids):** replies/reactions/edits embed the **target `Message`** — use
`content.target.id`. Poll votes embed the `poll` object — correlate via the originating poll message's
`id`.

---

## 3. Reactions (tapbacks) — monitoring & uses

A tapback is delivered as `message.reactionAdded` → inbound message with reaction content
`{ emoji: string, target: Message }` (`types-CyfLJXgu.d.ts:772-777`). `target.id` is the id of the
message that was reacted to.

**Uses in this product:**
1. **Engagement measurement.** When `reaction.target.id === sentMessageId` of a suggestion or bet
   confirmation (the id returned by `space.send`, see §4), set `BotSuggestion.engaged = true`, count it
   as positive feedback, and bump category affinity for future ranking.
2. **One-tap confirm/vote (optional, Folk-style).** A 👍 tapback on the bot's quote can act as a
   frictionless "confirm" alongside the typed "yup".
3. **Analytics.** Emit a `reaction_in` `BotEvent` carrying the emoji label + `targetGuid` (the reacted
   message), the actor (hashed handle), and the space (hashed) — **never message text**.

**Caveats (must-verify at runtime):**
- Only reaction-**added** is delivered; **reaction-removed is not** → engagement is monotonic (can't
  detect un-reacts).
- Confirm that `space.send()`'s returned `Message.id` equals the `target.id` a later tapback references.
  Send returns `Message | undefined` (`types-CyfLJXgu.d.ts:865-869`) and on an at-least-once transport
  the returned id may be client-minted; verify equality before trusting the correlation.

---

## 4. Outbound presentation toolkit (how we beat Folk's plain text)

`space.send(content)` → `Promise<Message | undefined>` (returns the sent message **with its `id`**, used
for tapback correlation); multi-send overload returns `Message[]` (`types-CyfLJXgu.d.ts:865-869`).
`space.responding(fn)` wraps a handler with typing indicators. Builders (verified in
`authoring-b9AhXgPI.d.ts` and `providers/imessage/index.d.ts`):

| Builder | Shape (verified) | Use in the Sawa agent |
|---|---|---|
| `richlink(url)` | `{ type:"richlink", url, title(), summary(), cover() }` — accessors are **lazy/async**, fetched once from the URL's OG metadata; **network/parse failure → `undefined`, cached, no retry** (`authoring:225-250`) | **Market card**: link to the market page → preview bubble with `og:image` cover + title. **Fallback to `markdown` if `cover()`/`title()` are empty. NEVER richlink a `isPrivate`/`isHidden` market** (OG image/title leaks to the space). |
| `poll(title, ...options)` / `poll(title, options[])` | `{ type:"poll", title, options:{title}[] }` (`authoring:180-223`) | **Tap-to-bet INTENT only** — a `poll_option` vote `{ option:{title}, poll, selected, title }` carries **no amount and no poll id** → pre-fill market+option (correlate by poll-message id/title, label→optionId by title) and route into validate→quote→confirm. **Never** call `placeBet` directly from a vote. |
| `markdown(text)` | markdown string | Clean odds bars (`Yes ▰▰▰▰▰▰▰░░░ 70%`), portfolio/leaderboard tables, quote cards. |
| `text(source)` incl. **stream** | `text(string)` or `text(StreamTextSource)` — iMessage streams by **editing the bubble in place** as chunks arrive (`authoring:257-277`) | "sawa is thinking…" live replies instead of a dead pause. |
| `attachment` (image) | image content with bytes | **Rendered cards/charts** (odds-bar PNG, price-history chart) — cleanest custom visual (phase-2). |
| `effect(content, effect)` (iMessage) | effects incl. `confetti`, `fireworks`, `balloons`, `celebration`, `lasers`, … — **inner content is `text`/`markdown`/`attachment` ONLY** (not richlink/poll; `types-CyfLJXgu.d.ts:130-146`) | **Delight**: confetti on bet placed / "you won" — sent as a **separate** text/markdown message, not wrapped around a rich card. |
| `reaction(emoji, target)` | `{ type:"reaction", emoji, target:Message }` | bot can tapback user messages (ack). |
| `customized-mini-app(input)` (iMessage) | `MSMessageTemplateLayout` `{ caption, subcaption, trailingCaption, trailingSubcaption, image, imageTitle, imageSubtitle, summary }` + `teamId`, `extensionBundleId`, `appStoreId?`, `url` (`providers/imessage/index.d.ts:75-113`) | **Richest interactive bubble** — but **requires a real iMessage app extension**. Future ceiling, not v1. |
| `group(...items)`, `voice`, `contact`, `background` | — | album bundles, voice notes, etc. (situational). |

**Standard market reply = `richlink` (visual card, with markdown fallback) + `markdown` (live odds +
optional pmxt anchor) + `poll` (tap-to-bet *intent*).** Money actions confirm via typed "yup"; a 👍
tapback may confirm only once `space.send` id ↔ tapback `target.id` is runtime-verified (else require
typed confirm) — and every execution dedupes on the confirming message's `id` (at-least-once delivery).
Degrade gracefully where `effect`/`attachment` isn't supported (provider warns-and-skips).

**No Apple Messages for Business native pickers.** AMB's list-picker / quick-reply / forms require AMB business
onboarding (approved MSP/CSP + per-use-case approval) or a signed iMessage app extension — **unavailable to a
third-party Spectrum bot.** Simulate them with numbered/emoji `markdown` lines + `richlink` cards + tapback
reactions (our "quick reply") + `poll`. Poke (the first Apple-approved iMessage AI agent) proves plain
text/markdown is sufficient. See `BUILD_PLAN.md` §2.1 for the distilled UX principles.

---

## 5. Delivery semantics & idempotency

Inbound delivery is **at-least-once** (webhook and stream) — the docs explicitly say to **dedupe on
`message.id`** for exactly-once side effects (`index.d.ts:2785-2788`). Spectrum's `Store` is
**in-memory only** (`types-CyfLJXgu.d.ts` Store) — there is no Spectrum-side persistence, so all durable
analytics/state must go to our own DB. ⇒ Every analytics write keys on `message.id`; the bot must not
double-send suggestions on redelivery (gate on the suggestion cooldown / `BotSuggestion` unique, not
just on receipt).

**Re-suggest / opt-out state lives server-side** (`POST /api/bot/state`, `Bearer <BOT_SECRET>`). Body
`{ handle?, spaceId?, handleKind? }` — **≥1 of handle/spaceId required**; the bot sends RAW values and the
server hashes. Response `{ optedOut, lastSuggestedAt: string|null, suggestedPredictionIds: string[] }`:
`handle` drives `optedOut`+`lastSuggestedAt` (from `BotActorState`), `spaceId` drives `suggestedPredictionIds`
(from `BotSuggestion`). Check this before a suggestion/money action so the bot honors `optedOut` and never
re-suggests a market already shown to the space (it's POST, not GET, to keep raw phone/email out of URL logs).

---

## 6. Analytics capture mapping (Spectrum → `POST /api/bot/events`)

**The client sends RAW values; the server hashes + resolves.** Part B sends RAW `handle`+`handleKind`+`spaceId`
in the request body; the server normalizes, HMAC-SHA256-hashes them (`BOT_HASH_SECRET`) into
`senderHandleHash`/`spaceIdHash`, resolves `userId`, and persists **only** the hashes (the bot **never** holds
`BOT_HASH_SECRET` and never computes a hash). `spaceId` is only `.trim()`'d before hashing — there is no
spaceId normalizer — so send a stable raw `space.id`.

**Required per event:** `eventGuid`, `platform` (lowercase `"imessage"`), `eventType` (closed set of 9 below),
`spaceId` (RAW), `occurredAt` (`message.timestamp.toISOString()`). Optional: `handle`+`handleKind`,
`spaceType`∈{dm,group}, `contentType`∈{text,image,poll,reaction,link,sticker,system,unknown}, `intent`
(slug `^[a-z0-9_.-]{1,64}$`), `predictionId`, `targetGuid`, `meta`. `linePhone` is accepted but never stored.

**`eventType` is a closed set of exactly 9** (anything else → that event rejected `invalid eventType`):
`message_in`, `reaction_in`, `poll_vote_in`, `command`, `odds_lookup`, `market_created`, `bet_quoted`,
`bet_placed`, `suggestion_sent`. The first four are `INBOUND_EVENT_TYPES` (bump `BotActorState.lastInboundAt`).

| Inbound / action | `eventType` | Fields the client sends (RAW handle/spaceId; server hashes) |
|---|---|---|
| `message.received` (command/NL) | `message_in` / `command` / `odds_lookup` | `eventGuid=message.id`, `occurredAt`, `handle`+`handleKind`, `spaceId`, `spaceType`, `contentType`, `intent`, `predictionId?` |
| `message.reactionAdded` | `reaction_in` | `eventGuid=<guid>:reaction:<seq>`, `targetGuid=target.id` — drives the engagement rollup when it matches a prior suggestion's `sentMessageId` in the same hashed space. **Emoji label is NOT storable** (`meta.emoji` is dropped by clampMeta) |
| `poll.changed` | `poll_vote_in` | `eventGuid=message.id`, `predictionId?`, `meta.outcome` (controlled label; `meta.optionLabel` is dropped) |
| bot creates a market | `market_created` | `predictionId`, minted `eventGuid` |
| bot quotes/places a bet | `bet_quoted` / `bet_placed` | `predictionId`, **`meta.stake`** (number) + `meta.oddsBps` + `meta.outcome` (NOT `meta.amount`/`optionLabel` — dropped) |
| bot surfaces a suggestion | `suggestion_sent` | `predictionId`, `meta.sentMessageId` (= the `space.send` id; falls back to `targetGuid`), `meta.source` (default `sawa`), `meta.rank`/`meta.score`/`meta.batchId`; deterministic `eventGuid` |

**Response is always 200 (partial success):** `{ received, inserted, deduped, rejected, errors[] }` — inspect
the counts, not just the status. Dedup is a P2002 on `eventGuid` → `deduped` (not `rejected`), so **whole
batches are safe to retry**; batch size **≤200**. Suggestion rollups (`BotSuggestion` upsert; `engaged=true`
on a matching `reaction_in`) fire **only on a fresh insert**, never on dedup.

**`meta` is a hard whitelist (`clampMeta`)** — only numbers `{rank,score,latencyMs,tokenCount,oddsBps,stake}`
and strings `{source,batchId,sentMessageId,command,outcome}` (≤64 chars), ≤12 keys; **every other key, free
text, and any nested object/array is silently dropped** (the PII guard). **Never stored:** raw handle, raw
`spaceId`, `linePhone`, message body. See `BETTING_BOT_PLAN.md` §7 for the full endpoint contract, the Prisma
models, and the 41-table RLS posture.

---

## 7. Identity derivation (phone-first, merged with WhatsApp)

- **DM:** `imessage(space).phone` is the counterpart's number → `findOrCreateUserByPhone` (merges with
  the existing WhatsApp ghost-user identity on the unique `phone`).
- **Group:** per-member identity from `message.sender.id` (the address). Classify `handleKind`: E.164 →
  `phone` (maps to `User.phone`); contains `@` → `email` (maps to `User.email` as a **distinct**
  identity — do not force-merge phone↔email).
- One person with both a phone-handle and an email-handle legitimately appears as two actors in v1.

---

## 8. Known limits / must-verify checklist
0. **Phase-0 Day-1 GATE — prove the live iMessage connection** (receive + reply in a real test group) before
   any feature work; items 1–2 are verified as part of this gate. See `BUILD_PLAN.md` §3.2.
1. Real `sender.id` format (phone vs email) and the email rate — log on first real chats.
2. `space.send()` returned id == tapback `target.id` (gates reaction engagement).
3. Webhook vs stream inbound path → dedupe on `message.id` if `app.webhook()`.
4. Exact DM `space.id` string shape (it embeds an address → must be hashed before storage).
5. No reaction-removed / no read / no typing / no opened — design accordingly (done).
