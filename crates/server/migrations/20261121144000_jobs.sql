-- T1.5 job queue. Runners claim rows from `jobs` with FOR UPDATE SKIP LOCKED;
-- every state change also appends a row to `job_events`, which feeds the
-- per-project server-sent events stream.
--
-- `project_id` has no foreign key yet: the projects table arrives with T1.1.
-- T1.1 must add `ALTER TABLE jobs ADD CONSTRAINT jobs_project_fk FOREIGN KEY
-- (project_id) REFERENCES projects (id) ON DELETE CASCADE` (and the same for
-- `job_events`) in its own migration.
CREATE TABLE jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL,
    kind         TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    -- Earliest time the job may be claimed (pushed out on retry back-off).
    run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_by   TEXT,
    heartbeat_at TIMESTAMPTZ,
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (run_at, created_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (heartbeat_at) WHERE status = 'running';
CREATE INDEX jobs_project_idx ON jobs (project_id, created_at DESC);

CREATE TABLE job_events (
    id         BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL,
    job_id     UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX job_events_project_idx ON job_events (project_id, id);
