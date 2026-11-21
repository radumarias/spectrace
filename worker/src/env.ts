/** Cloudflare bindings, in step with `wrangler.toml`. */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /** "json" (default, one JSON object per line) or "pretty". */
  LOG_FORMAT?: string;
  /** GitHub OAuth app. Secrets (`wrangler secret put`, or `.dev.vars` locally). Sign-in answers 500 until both are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Where browsers reach the app, no trailing slash. The OAuth callback is `<PUBLIC_URL>/api/auth/github/callback`. */
  PUBLIC_URL?: string;
  /** Overrides for tests: default `https://github.com` and `https://api.github.com`. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
