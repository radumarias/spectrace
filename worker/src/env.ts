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
  /** GitHub App (T1.2). Secrets: the numeric App ID, the app's URL slug, and its PEM private key (PKCS#1 or PKCS#8). Repo routes answer 500 until all three are set. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Overrides for tests: default `https://github.com` and `https://api.github.com`. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
