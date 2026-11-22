import type { DevpageServer } from "./devpage-container";
import type { ProjectHub } from "./hub";
import type { JobMessage } from "./jobs/queue";

/** Cloudflare bindings, in step with `wrangler.toml`. */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Producer for the job queue (consumer is this Worker's `queue` handler). */
  JOBS: Queue<JobMessage>;
  /** One ProjectHub per project, addressed by project id. */
  PROJECT_HUB: DurableObjectNamespace<ProjectHub>;
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
  /** The GitHub App's webhook secret (T2.2). Secret. The webhook endpoint answers 500 until it is set. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** devpage server as a Cloudflare Container (see src/devpage.ts). Used only once DEVPAGE_BUCKET_URL is set. */
  DEVPAGE?: DurableObjectNamespace<DevpageServer>;
  /** Where devpage server keeps every version: `s3://<bucket>/<prefix>`, an R2 bucket through its S3 API. Unset, devpage is off. */
  DEVPAGE_BUCKET_URL?: string;
  /** R2's S3 endpoint, `https://<account id>.r2.cloudflarestorage.com`, and an R2 API token's keys (secrets). */
  AWS_ENDPOINT_URL?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  /** A devpage server reached over HTTP instead of the container: a local `devpage server`, or a fake in tests. */
  DEVPAGE_ORIGIN?: string;
  /** Claude through Cloudflare AI Gateway (src/ai.ts). Secrets: `ANTHROPIC_API_KEY` (a standard API key; optional when the gateway stores one), `CF_AIG_TOKEN` (only if the gateway requires auth). Vars: account id, gateway id (default "default"). The AI routes answer 503 until configured. */
  ANTHROPIC_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Overrides the gateway URL (tests). */
  ANTHROPIC_BASE_URL?: string;
  /** Overrides for tests: default `https://github.com` and `https://api.github.com`. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
