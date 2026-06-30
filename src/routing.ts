/**
 * Pure routing helpers (no Spectrum imports) so mention-gating + idempotency are unit-testable.
 *
 * Gating rule: DMs are always addressed; in a group the bot only answers when explicitly hailed
 * (`sawa …` / `@sawa …`) or via a slash command — bystander chatter is ignored (it may still feed
 * the rolling buffer for future reply-driven suggestions). This is the iMessage-correct posture:
 * there is no "@mention" event, so we infer addressing from the text (SPECTRUM_INTEGRATION §1).
 */

import type { Intent } from "./sawa/intent";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * When a message is NOT hailed but there's an active thread (the "relaxed" path — so follow-ups and
 * poll answers work without re-typing "sawa"), decide whether it's safe to act on the parsed intent.
 *
 * `next`/`link`/`answer` are always honored (they're meaningless except as in-thread follow-ups). For a
 * `search` the bar depends on the space:
 *   - **DM** — an active session only exists because this person deliberately hailed the bot in a 1:1
 *     thread, and every message in that thread is to the bot. So honor ANY search, including a bare
 *     topic / a refinement the LLM classified ("No I meant s&p price range") — this is the fix for the
 *     dropped follow-up. `other` (greeting/small talk) is still ignored, so "ok"/"thanks" won't reply.
 *   - **GROUP** — bystanders are really talking to each other, so require an EXPLICIT regex trigger
 *     ("find a market on X" / "odds on Y") and stay silent on a bare-topic guess (`via` !== "regex").
 * A reply to a pending clarify the bot asked is handled by the caller BEFORE this gate (it is a direct
 * answer to our question), so it is honored in either space regardless of this.
 */
export function actionableWhenRelaxed(intent: Intent, isGroup: boolean): boolean {
  if (intent.kind === "next" || intent.kind === "link" || intent.kind === "answer") return true;
  if (intent.kind === "search") return !isGroup || intent.via === "regex";
  return false;
}

/**
 * Does `body` hail the bot by name? True when it starts with the bot name (optionally prefixed by
 * a greeting and/or `@`), or contains `@name` anywhere. Case-insensitive.
 */
export function mentionsBot(body: string, botName: string): boolean {
  const name = escapeRegex(botName.trim());
  if (!name) return false;
  const atStart = new RegExp(`^\\s*(?:hey|hi|hello|yo|ok|okay)?[\\s,]*@?${name}\\b`, "i");
  const atMention = new RegExp(`@${name}\\b`, "i");
  return atStart.test(body) || atMention.test(body);
}

/**
 * The identity that OWNS a conversation thread (and any pending clarify) in a space.
 *
 * A DM is 1:1, so the counterparty is implicit — we bind to the SPACE, NOT the sender handle. This is
 * the fix for the live "follow-ups not tracked / '2' ignored" bug: in LOCAL mode the same DM sender's
 * handle FLAPS between their number and "unknown" (chat.db's `LEFT JOIN handle` doesn't resolve every
 * inbound row), so a per-handle key sent the clarify ANSWER to a different bucket than the QUESTION.
 * Binding a DM to the space is handle-independent, so the answer always lands on the same thread.
 *
 * A GROUP keeps per-handle ownership so each member has their own thread and a bystander can't answer
 * someone else's clarify; an unresolved group handle stays "unknown" (those are never relaxed — see
 * `canRelaxSender` — so they can't ride another member's session).
 */
export function threadOwner(spaceId: string, senderId: string, isGroup: boolean): string {
  if (!isGroup) return `dm:${spaceId}`;
  return senderId && senderId !== "unknown" ? senderId : "unknown";
}

/** Conversation-memory key: per (space, thread-owner). DMs collapse to one bucket per space (see above). */
export function sessionKey(spaceId: string, senderId: string, isGroup: boolean): string {
  return `${spaceId} ${threadOwner(spaceId, senderId, isGroup)}`;
}

/**
 * May an UNHAILED sender be relaxed into an active thread (hail-free follow-ups)? Always yes for a DM —
 * the one counterparty is unambiguous even when their handle didn't resolve. In a GROUP an unknown
 * handle is NEVER relaxed (it shares the per-space "unknown" bucket, so a bystander could otherwise
 * ride another member's session); known group members relax normally.
 */
export function canRelaxSender(senderId: string, isGroup: boolean): boolean {
  return isGroup ? senderId !== "unknown" : true;
}

/**
 * Canonicalize a sender handle so the same human is keyed consistently regardless of how the
 * platform spells them. iMessage delivers a user as either a phone number (in any of several
 * formats) or an email-style Apple ID, and a project's Photon allowlist may hold one form while
 * Apple sends another — the "different text vs numbers" drift. Emails are lowercased; phones are
 * reduced to digits with a preserved leading "+". This removes formatting drift ("(555) 123-4567"
 * vs "+15551234567") for our own per-user keying/logging; it does NOT reconcile a phone with an
 * email for the same person (only the platform can do that).
 */
export function normalizeHandle(id: string): string {
  const s = id.trim();
  if (!s) return s;
  if (s.includes("@")) return s.toLowerCase(); // email-style Apple ID
  const digits = s.replace(/\D/g, "");
  if (!digits) return s.toLowerCase(); // no digits → not a phone (e.g. "unknown")
  return s.startsWith("+") ? `+${digits}` : digits;
}

/** Decide whether to handle a message. Slash commands and DMs always pass; groups need a mention. */
export function shouldHandle(args: {
  isGroup: boolean;
  isSlash: boolean;
  body: string;
  botName: string;
}): boolean {
  if (args.isSlash) return true;
  if (!args.isGroup) return true;
  return mentionsBot(args.body, args.botName);
}

/**
 * Bounded set of message ids already acted on — the idempotency guard for at-least-once delivery
 * (a redelivered message must not double-reply). FIFO eviction keeps memory flat for a long-running
 * daemon.
 */
export class SeenSet {
  private readonly set = new Set<string>();
  private readonly queue: string[] = [];
  constructor(private readonly max = 1000) {}

  /** Returns true if `id` was already seen; otherwise records it and returns false. */
  seen(id: string): boolean {
    if (this.set.has(id)) return true;
    this.set.add(id);
    this.queue.push(id);
    if (this.queue.length > this.max) {
      const evicted = this.queue.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
    return false;
  }
}
