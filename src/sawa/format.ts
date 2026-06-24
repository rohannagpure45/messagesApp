/** Render markets into chat-friendly text. Platform-neutral (works on iMessage + terminal). */
import type { Market } from "./types";

const DISCLAIMER = "Virtual Sawa coins — entertainment only, no cash value.";

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}

function deadlineSuffix(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ` · closes ${d.toISOString().slice(0, 10)}`;
}

/** One-market detail block. */
export function formatMarket(m: Market): string {
  const odds = m.outcomes.map((o) => `${o.label} ${pct(o.oddsPct)}`).join("  ·  ");
  return `${m.title}${deadlineSuffix(m.deadline)}\n${odds || "(no odds yet)"}`;
}

/** Numbered list of markets with a disclaimer footer. */
export function formatList(markets: Market[]): string {
  if (markets.length === 0) return `No open markets found.\n${DISCLAIMER}`;
  const lines = markets.map((m, i) => {
    const top = m.outcomes
      .slice(0, 3)
      .map((o) => `${o.label} ${pct(o.oddsPct)}`)
      .join(" / ");
    return `${i + 1}. ${m.title} — ${top || "no odds"}`;
  });
  return `Open markets:\n${lines.join("\n")}\n\n${DISCLAIMER}`;
}
