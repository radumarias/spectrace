import type { ClaudeCodeRunner } from "./claude-code-container";
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
  /** Claude Code in a Cloudflare Container on the owner's Claude subscription (src/claude-code.ts). Used only once CLAUDE_CODE_OAUTH_TOKEN is set. */
  CLAUDE_CODE?: DurableObjectNamespace<ClaudeCodeRunner>;
  /** Secret: a token from `claude setup-token` (Pro, Max, Ultra, Team or Enterprise plan). */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** The one GitHub login whose work may run on that subscription; everyone else uses the API key. Unset, nobody does. */
  CLAUDE_CODE_OWNER?: string;
  /** A Claude Code server reached over HTTP instead of the container: a local one, or a fake in tests. */
  CLAUDE_CODE_ORIGIN?: string;
  /** Secret: 32 random bytes as base64 (`openssl rand -base64 32`), the AES-GCM key for users' saved API keys (src/user-keys.ts). Saving keys answers 503 until set. */
  SECRETS_KEY?: string;
  /** A GitLab instance (self-hosted or https://gitlab.com), no trailing slash. Unset, GitLab is off. */
  GITLAB_URL?: string;
  /** The instance's OAuth application (secrets). Redirect URI `<PUBLIC_URL>/api/gitlab/callback`, scopes `api read_user`. Unset, people connect with a personal access token instead. */
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  /** Secret: the token GitLab sends in `X-Gitlab-Token` with each webhook. spectrace puts it on the hooks it creates. The webhook answers 500 until set. */
  GITLAB_WEBHOOK_SECRET?: string;
  /** Overrides for tests: default `https://github.com` and `https://api.github.com`. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
