-- T1.5 follow-up now that `projects` exists (0020): jobs and their events
-- belong to a project and go away with it. D1 is SQLite and cannot ADD
-- CONSTRAINT, so both tables are rebuilt. Rows that point at a project that
-- does not exist (only possible before this migration) are dropped.
CREATE TABLE jobs_new (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
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

INSERT INTO jobs_new SELECT * FROM jobs WHERE project_id IN (SELECT id FROM projects);

CREATE TABLE job_events_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    job_id     TEXT NOT NULL REFERENCES jobs_new (id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO job_events_new SELECT * FROM job_events WHERE job_id IN (SELECT id FROM jobs_new);

DROP TABLE job_events;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
ALTER TABLE job_events_new RENAME TO job_events;

CREATE INDEX jobs_project_idx ON jobs (project_id, created_at DESC);
CREATE INDEX job_events_project_idx ON job_events (project_id, id);
