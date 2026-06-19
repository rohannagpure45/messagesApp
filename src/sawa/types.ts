/** Venue-neutral market types (Sawa today; Kalshi/others can reuse the shape). */

export interface Outcome {
  label: string;
  /** Latest odds as a percentage (0–100), or null if no snapshot yet. */
  oddsPct: number | null;
}

export interface Market {
  venue: "sawa";
  /** Stable cross-venue reference, e.g. "sawa:<id>". */
  ref: string;
  id: string;
  title: string;
  category?: string;
  /** ISO timestamp string of the prediction deadline. */
  deadline?: string;
  resolved: boolean;
  outcomes: Outcome[];
  /** Tappable link when SAWA_MARKET_URL_TEMPLATE is configured. */
  url?: string;
}
