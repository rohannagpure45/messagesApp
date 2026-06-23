/** Environment → typed config for the read path. Loaded once at startup. */

export interface Config {
  /** Base URL of the Sawa web app, e.g. `https://sawapredictions.com`. Reads hit `${apiBaseUrl}/api/predictions*`. */
  apiBaseUrl: string;
  /** Optional template like `https://.../market/{id}` used to build tappable links. */
  marketUrlTemplate?: string;
}

/** Thrown when a required environment variable is missing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBaseUrl = env.SAWA_API_BASE_URL;
  if (!apiBaseUrl) throw new ConfigError("SAWA_API_BASE_URL is not set");
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    marketUrlTemplate: env.SAWA_MARKET_URL_TEMPLATE,
  };
}
