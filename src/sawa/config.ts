/** Environment → typed config for the read path. Loaded once at startup. */

export interface Config {
  supabaseUrl: string;
  supabaseKey: string;
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
  const supabaseUrl = env.SAWA_SUPABASE_URL;
  const supabaseKey = env.SAWA_SUPABASE_KEY;
  if (!supabaseUrl) throw new ConfigError("SAWA_SUPABASE_URL is not set");
  if (!supabaseKey) throw new ConfigError("SAWA_SUPABASE_KEY is not set");
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
    supabaseKey,
    marketUrlTemplate: env.SAWA_MARKET_URL_TEMPLATE,
  };
}
