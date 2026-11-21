/** Cloudflare bindings, in step with `wrangler.toml`. */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /** "json" (default, one JSON object per line) or "pretty". */
  LOG_FORMAT?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
