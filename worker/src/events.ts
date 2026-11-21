// Job events as stored in D1 and as sent to browsers. Kept apart from hub.ts so code that
// only needs these types (and `just api-client`, which runs under Node) never loads `cloudflare:workers`.

/** One row of `job_events`, as sent to browsers. */
export interface JobEvent {
  id: number;
  projectId: string;
  jobId: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface EventRow {
  id: number;
  project_id: string;
  job_id: string;
  event: string;
  data: string;
  created_at: string;
}

export function toEvent(row: EventRow): JobEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    event: row.event,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
