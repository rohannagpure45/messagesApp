/**
 * Environment → typed config. Loaded once at startup.
 *
 * Three independent surfaces, by design:
 *  - `Config`       — the Sawa read path. `SAWA_API_BASE_URL` is the ONLY hard requirement
 *                     (Option C: public GET endpoints, no DB credentials). Always available.
 *  - `PmxtConfig`   — OPTIONAL cross-venue (Kalshi/Polymarket) enrichment. Absent → search
 *                     degrades to Sawa-only. Never blocks a reply.
 *  - `IntentConfig` — OPTIONAL Gemini Flash-Lite intent parser. Absent → the regex-first gate
 *                     handles classification/extraction on its own.
 *
 * Keeping the enrichers optional means the terminal dev loop and the core Sawa reply work with
 * nothing but `SAWA_API_BASE_URL` set.
 */

export interface Config {
  /** Base URL of the Sawa web app, e.g. `https://sawapredictions.com`. Reads hit `${apiBaseUrl}/api/predictions*`. */
  apiBaseUrl: string;
  /** Optional template like `https://.../predictions/{id}` used to build tappable links. */
  marketUrlTemplate?: string;
  /** The name the bot answers to for group mention-gating (default `sawa`). */
  botName: string;
}

/** Optional pmxt (cross-venue Kalshi/Polymarket) read-only enrichment config. */
export interface PmxtConfig {
  /** `pmxt_live_…` bearer key. */
  apiKey: string;
  /** REST base — defaults to the catalog/read host `https://api.pmxt.dev` (NEVER the trade host). */
  baseUrl: string;
  /** Builder-mode flag (informational; this client is GET-only and never trades). */
  builderMode: boolean;
}

/** Optional intent-LLM config (Gemini Flash-Lite via the OpenAI-compatible API). */
export interface IntentConfig {
  apiKey: string;
  /** Model id, e.g. `gemini-2.5-flash-lite`. */
  model: string;
  /** OpenAI-compatible base URL (Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/`). */
  baseUrl: string;
}

const DEFAULT_BOT_NAME = "sawa";
const DEFAULT_PMXT_BASE_URL = "https://api.pmxt.dev";
const DEFAULT_INTENT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_INTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Thrown when a required environment variable is missing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function trimTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBaseUrl = env.SAWA_API_BASE_URL;
  if (!apiBaseUrl) throw new ConfigError("SAWA_API_BASE_URL is not set");
  return {
    apiBaseUrl: trimTrailingSlashes(apiBaseUrl),
    marketUrlTemplate: env.SAWA_MARKET_URL_TEMPLATE,
    botName: (env.SAWA_BOT_NAME || DEFAULT_BOT_NAME).trim().toLowerCase(),
  };
}

/**
 * Cross-venue enrichment config. Returns null (not an error) when `PMXT_API_KEY` is unset, so
 * the bot runs Sawa-only without it. The base URL is pinned to the catalog/read host; the trade
 * host (`trade.pmxt.dev`) is never used by this bot.
 */
export function getPmxtConfig(env: NodeJS.ProcessEnv = process.env): PmxtConfig | null {
  const apiKey = env.PMXT_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: trimTrailingSlashes(env.PMXT_API_BASE_URL || DEFAULT_PMXT_BASE_URL),
    builderMode: env.PMXT_BUILDER_MODE === "true",
  };
}

/**
 * Intent-LLM config. Returns null when `INTENT_LLM_API_KEY` is unset, in which case the
 * regex-first gate in `intent.ts` does all the classification/extraction on its own.
 */
export function getIntentConfig(env: NodeJS.ProcessEnv = process.env): IntentConfig | null {
  const apiKey = env.INTENT_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: (env.INTENT_LLM_MODEL || DEFAULT_INTENT_MODEL).trim(),
    // No trailing slash — the OpenAI SDK appends `/chat/completions` itself.
    baseUrl: trimTrailingSlashes(env.INTENT_LLM_BASE_URL || DEFAULT_INTENT_BASE_URL),
  };
}
