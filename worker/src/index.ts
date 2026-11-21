import { createApp } from "./app";
import type { Bindings } from "./env";
import { consume, type JobMessage } from "./jobs/queue";
import "./jobs/sync"; // registers the "sync" job kind

export { ProjectHub } from "./hub";

const app = createApp();

// Only /api/* reaches `fetch` (see `run_worker_first` in wrangler.toml);
// the web app is served by Workers Static Assets. `queue` runs the job queue.
export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<JobMessage>, env: Bindings) => consume(batch, env),
} satisfies ExportedHandler<Bindings, JobMessage>;
