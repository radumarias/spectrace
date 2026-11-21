-- T1.5 job dispatch. `jobs` is the source of truth for state; the Cloudflare
-- Queue only carries `{ jobId }`. Every state change also appends a row to
-- `job_events`, which is the job log, the live progress feed (via the
-- ProjectHub Durable Object) and the replay source for reconnecting clients.
--
-- Numbered 0003, after T0.8 (0010) and before T1.1 (0020); see 0021 for the foreign keys.
--
-- `project_id` has no foreign key here (projects did not exist yet); 0021 adds them.
CREATE TABLE jobs (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
    target       TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at  TEXT
);

CREATE INDEX jobs_project_idx ON jobs (project_id, created_at DESC);

CREATE TABLE job_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    job_id     TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX job_events_project_idx ON job_events (project_id, id);
