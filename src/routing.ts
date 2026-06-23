/**
 * Pure routing helpers (no Spectrum imports) so mention-gating + idempotency are unit-testable.
 *
 * Gating rule: DMs are always addressed; in a group the bot only answers when explicitly hailed
 * (`sawa …` / `@sawa …`) or via a slash command — bystander chatter is ignored (it may still feed
 * the rolling buffer for future reply-driven suggestions). This is the iMessage-correct posture:
 * there is no "@mention" event, so we infer addressing from the text (SPECTRUM_INTEGRATION §1).
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
