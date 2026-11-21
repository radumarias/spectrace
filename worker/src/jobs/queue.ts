import type { Bindings } from "../env";
import { toEvent, type EventRow, type JobEvent } from "../hub";
import { AppError } from "../error";
import { log } from "../log";

export const JOBS_QUEUE = "spectrace-jobs";
export const JOBS_DLQ = "spectrace-jobs-dlq";

/** A running job that has not changed for this long is presumed dead and may be claimed again. */
const LEASE_SECONDS = 120;

export interface JobRow {
  id: string;
  project_id: string;
  kind: string;
  target: string;
  state: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface JobContext {
  env: Bindings;
  /** Send a progress event to everyone watching the project. */
  progress(data: Record<string, unknown>): Promise<void>;
}

/**
 * A job handler must be idempotent by `job.id`: the queue delivers at least
 * once, and a failed attempt is run again. Key every external effect on the
 * job id (for example `INSERT OR IGNORE` with the id in the key).
 */
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Later tasks register their kinds ("sync", "index", ...) here. */
export function registerHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export function unregisterHandler(kind: string): void {
  handlers.delete(kind);
}

/** Message body on the queue. All state lives in D1. */
export interface JobMessage {
  jobId: string;
}

/** Append an event to the job log and push it to the project's hub. */
export async function emit(env: Bindings, job: Pick<JobRow, "id" | "project_id">, event: string, data: Record<string, unknown> = {}): Promise<JobEvent> {
  const row = await env.DB.prepare(
    "INSERT INTO job_events (project_id, job_id, event, data) VALUES (?1, ?2, ?3, ?4) RETURNING id, project_id, job_id, event, data, created_at",
  )
    .bind(job.project_id, job.id, event, JSON.stringify(data))
    .first<EventRow>();
  if (!row) throw new Error("job_events insert returned no row");
  const ev = toEvent(row);
  try {
    await env.PROJECT_HUB.getByName(job.project_id).publish(ev);
  } catch (error) {
    // The event is stored, so reconnecting clients still get it; never fail the job over a push.
    log("warn", "hub publish failed", { jobId: job.id, error: String(error) }, env.LOG_FORMAT);
  }
  return ev;
}

/** Create a job, record "queued", and put it on the queue. If the queue refuses, the job is marked failed and an `upstream` error is thrown. */
export async function enqueueJob(env: Bindings, projectId: string, kind: string, target = "", maxAttempts = 3): Promise<JobRow> {
  const id = crypto.randomUUID();
  const row = await env.DB.prepare("INSERT INTO jobs (id, project_id, kind, target, max_attempts) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *")
    .bind(id, projectId, kind, target, maxAttempts)
    .first<JobRow>();
  if (!row) throw new AppError("internal", "job insert returned no row");
  await emit(env, row, "queued", { kind: row.kind, target: row.target });
  try {
    await env.JOBS.send({ jobId: id });
  } catch (cause) {
    log("error", "queue send failed", { jobId: id, error: String(cause) }, env.LOG_FORMAT);
    await env.DB.prepare("UPDATE jobs SET state = 'failed', error = 'could not be queued', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1").bind(id).run();
    await emit(env, row, "failed", { error: "could not be queued" });
    throw new AppError("upstream", "queue send failed", { cause });
  }
  return row;
}

/** Delay before the next try: 5 s, doubling, capped at 5 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** (attempts - 1), 300);
}

async function getJob(env: Bindings, id: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

async function finish(env: Bindings, job: JobRow, state: "queued" | "succeeded" | "failed", error: string | null): Promise<boolean> {
  const done = state !== "queued";
  const res = await env.DB.prepare(
    `UPDATE jobs SET state = ?2, error = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       finished_at = CASE WHEN ?4 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
     WHERE id = ?1 AND state = 'running' AND attempts = ?5`,
  )
    .bind(job.id, state, error, done ? 1 : 0, job.attempts)
    .run();
  return res.meta.changes === 1;
}

/** Process one delivery of a job message. Exactly one of ack/retry is called on `msg`. */
async function processOne(env: Bindings, msg: Message<JobMessage>): Promise<void> {
  const jobId = msg.body?.jobId;
  const existing = typeof jobId === "string" ? await getJob(env, jobId) : null;
  if (!existing) {
    log("warn", "job message for unknown job", { jobId: String(jobId) }, env.LOG_FORMAT);
    msg.ack();
    return;
  }

  // Claim: only a queued job (or a running one whose lease ran out) can start.
  // This is what makes duplicate and concurrent deliveries harmless.
  const job = await env.DB.prepare(
    `UPDATE jobs SET state = 'running', attempts = attempts + 1, error = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?1 AND (state = 'queued'
       OR (state = 'running' AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2)))
     RETURNING *`,
  )
    .bind(jobId, `-${LEASE_SECONDS} seconds`)
    .first<JobRow>();

  if (!job) {
    const current = await getJob(env, existing.id);
    if (current?.state === "running") msg.retry({ delaySeconds: 30 }); // someone else is on it
    else msg.ack(); // already succeeded or failed: duplicate delivery
    return;
  }

  await emit(env, job, "started", { attempt: job.attempts, kind: job.kind, target: job.target });

  const handler = handlers.get(job.kind);
  try {
    if (!handler) throw new PermanentError(`no handler for kind "${job.kind}"`);
    await handler(job, { env, progress: (data) => emit(env, job, "progress", data).then(() => undefined) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = error instanceof PermanentError || job.attempts >= job.max_attempts;
    if (final) {
      if (await finish(env, job, "failed", message)) await emit(env, job, "failed", { attempt: job.attempts, error: message });
      msg.ack();
    } else {
      const delaySeconds = backoffSeconds(job.attempts);
      if (await finish(env, job, "queued", message)) await emit(env, job, "retrying", { attempt: job.attempts, error: message, delaySeconds });
      msg.retry({ delaySeconds });
    }
    return;
  }

  if (await finish(env, job, "succeeded", null)) await emit(env, job, "succeeded", { attempt: job.attempts });
  msg.ack();
}

/** A failure that retrying cannot fix. */
export class PermanentError extends Error {}

/** Dead-letter queue: the consumer could not finish the message at all. */
async function processDead(env: Bindings, msg: Message<JobMessage>): Promise<void> {
  const job = typeof msg.body?.jobId === "string" ? await getJob(env, msg.body.jobId) : null;
  if (job && job.state !== "succeeded" && job.state !== "failed") {
    await env.DB.prepare(
      `UPDATE jobs SET state = 'failed', error = 'dead-lettered', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1`,
    )
      .bind(job.id)
      .run();
    await emit(env, job, "failed", { error: "dead-lettered" });
  }
  msg.ack();
}

/** The Worker's `queue` handler. */
export async function consume(batch: MessageBatch<JobMessage>, env: Bindings): Promise<void> {
  for (const msg of batch.messages) {
    try {
      if (batch.queue === JOBS_DLQ) await processDead(env, msg);
      else await processOne(env, msg);
    } catch (error) {
      // Infrastructure failure (D1 down, ...): let the queue redeliver, and eventually dead-letter.
      log("error", "job message failed", { id: msg.id, error: String(error) }, env.LOG_FORMAT);
      msg.retry({ delaySeconds: 10 });
    }
  }
}
