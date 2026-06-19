/**
 * Sawa market reads via Supabase PostgREST — GET only.
 *
 * Mirrors the public-feed contract documented in docs/DATABASE_MAP.md:
 *   public Prediction (isPrivate=false, isHidden=false, resolved=false)
 *   + embedded Option, + latest OddsSnapshot per option = current odds.
 *
 * PII guardrail: only a hard-coded column allowlist is ever selected. The `User`
 * table and its email/phone/password/googleId are NEVER queried or surfaced.
 */
import { getJson } from "./http";
import type { Config } from "./config";
import type { Market, Outcome } from "./types";

const SAFE_PREDICTION_COLS =
  "id,title,description,category,deadline,resolved,winningOptionId,leagueId,createdAt";

interface RawOption {
  id: string;
  label: string;
}

interface RawPrediction {
  id: string;
  title: string;
  description: string | null;
  category: string;
  deadline: string;
  resolved: boolean;
  winningOptionId: string | null;
  leagueId: string | null;
  createdAt: string;
  Option: RawOption[];
}

interface RawOdds {
  optionId: string;
  percentage: number;
  createdAt: string;
}

function authHeaders(cfg: Config): Record<string, string> {
  return { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` };
}

function marketUrl(cfg: Config, id: string): string | undefined {
  return cfg.marketUrlTemplate ? cfg.marketUrlTemplate.replace("{id}", id) : undefined;
}

export interface ListOptions {
  search?: string;
  limit?: number;
}

/** List open, public markets (newest first), optionally filtered by a title search. */
export async function listMarkets(cfg: Config, opts: ListOptions = {}): Promise<Market[]> {
  const { search, limit = 10 } = opts;
  const url = new URL(`${cfg.supabaseUrl}/rest/v1/Prediction`);
  url.searchParams.set("select", `${SAFE_PREDICTION_COLS},Option(id,label)`);
  url.searchParams.set("isPrivate", "eq.false");
  url.searchParams.set("isHidden", "eq.false");
  url.searchParams.set("resolved", "eq.false");
  url.searchParams.set("order", "createdAt.desc");
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 50))));
  if (search) url.searchParams.set("title", `ilike.*${search}*`);

  const rows = await getJson<RawPrediction[]>(url, authHeaders(cfg));
  return Promise.all(rows.map((r) => toMarket(cfg, r)));
}

/** Fetch a single public market by id, with current odds. */
export async function getMarket(cfg: Config, id: string): Promise<Market | null> {
  const url = new URL(`${cfg.supabaseUrl}/rest/v1/Prediction`);
  url.searchParams.set("select", `${SAFE_PREDICTION_COLS},Option(id,label)`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("isPrivate", "eq.false");
  url.searchParams.set("isHidden", "eq.false");
  url.searchParams.set("limit", "1");

  const rows = await getJson<RawPrediction[]>(url, authHeaders(cfg));
  const row = rows[0];
  return row ? toMarket(cfg, row) : null;
}

/** Latest OddsSnapshot.percentage per option for a prediction (first seen wins under desc order). */
async function latestOddsByOption(cfg: Config, predictionId: string): Promise<Map<string, number>> {
  const url = new URL(`${cfg.supabaseUrl}/rest/v1/OddsSnapshot`);
  url.searchParams.set("select", "optionId,percentage,createdAt");
  url.searchParams.set("predictionId", `eq.${predictionId}`);
  url.searchParams.set("order", "createdAt.desc");
  url.searchParams.set("limit", "1000");

  const rows = await getJson<RawOdds[]>(url, authHeaders(cfg));
  const latest = new Map<string, number>();
  for (const r of rows) {
    if (!latest.has(r.optionId)) latest.set(r.optionId, r.percentage);
  }
  return latest;
}

async function toMarket(cfg: Config, r: RawPrediction): Promise<Market> {
  const odds = await latestOddsByOption(cfg, r.id);
  const outcomes: Outcome[] = (r.Option ?? []).map((o) => ({
    label: o.label,
    oddsPct: odds.get(o.id) ?? null,
  }));
  return {
    venue: "sawa",
    ref: `sawa:${r.id}`,
    id: r.id,
    title: r.title,
    category: r.category,
    deadline: r.deadline,
    resolved: r.resolved,
    outcomes,
    url: marketUrl(cfg, r.id),
  };
}
