-- T1.5 job dispatch. `jobs` is the source of truth for state; the Cloudflare
-- Queue only carries `{ jobId }`. Every state change also appends a row to
-- `job_events`, which is the job log, the live progress feed (via the
-- ProjectHub Durable Object) and the replay source for reconnecting clients.
--
-- Numbered 0003 so it sits after T0.8's 0002 (sign-in).
--
-- `project_id` has no foreign key yet: the projects table arrives with T1.1.
-- T1.1 must rebuild `jobs` and `job_events` with `REFERENCES projects (id)
-- ON DELETE CASCADE` in its own migration (D1 is SQLite: no ADD CONSTRAINT).
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
