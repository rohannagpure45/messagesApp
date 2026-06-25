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
 * When a message is NOT hailed but there's an active thread in the space (the "relaxed" path — so
 * follow-ups and poll answers work without re-typing "sawa"), decide whether it's safe to act on the
 * parsed intent. We continue the thread (`next`/`link`) or honor an EXPLICIT search request (a regex
 * trigger like "find a market on X" / "odds on Y") — but NEVER a bare-topic guess (`via` !== "regex")
 * or small talk, so the bot stays silent on inbox bystander chatter it merely overheard. A pending
 * clarify answer is resolved by the caller BEFORE this gate, so it is unaffected.
 */
export function actionableWhenRelaxed(intent: Intent): boolean {
  // `answer` = a grounded question about the shown market — a natural in-thread follow-up.
  if (intent.kind === "next" || intent.kind === "link" || intent.kind === "answer") return true;
  if (intent.kind === "search") return intent.via === "regex";
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
