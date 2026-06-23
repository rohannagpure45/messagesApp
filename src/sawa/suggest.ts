/**
 * /suggest support. Spectrum exposes a FORWARD message stream, not history — so we keep
 * a small rolling buffer of recent non-command messages, scoped by sender id
 * (resourceId, per Spectrum best-practices). `suggestPayload` emits a one-shot object
 * for an agent to reason over; no LLM call happens here.
 */
import type { Market } from "./types";

export class RecentBuffer {
  private readonly bySender = new Map<string, string[]>();

  constructor(private readonly max = 20) {}

  push(senderId: string, line: string): void {
    const arr = this.bySender.get(senderId) ?? [];
    arr.push(line);
    while (arr.length > this.max) arr.shift();
    this.bySender.set(senderId, arr);
  }

  recent(senderId: string): string[] {
    return [...(this.bySender.get(senderId) ?? [])];
  }
}

export interface SuggestPayload {
  marketSnapshot: string[];
  messages: string[];
  guidance: string;
}

export function suggestPayload(markets: Pick<Market, "title">[], messages: string[]): SuggestPayload {
  return {
    marketSnapshot: markets.map((m) => m.title),
    messages,
    guidance: "Propose 1-3 NEW market ideas grounded in the chat; label them as demo suggestions.",
  };
}
