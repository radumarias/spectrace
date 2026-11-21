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
}

export type AppEnv = { Bindings: Bindings; Variables: { requestId: string } };
