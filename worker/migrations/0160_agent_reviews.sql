-- T3.4: agent reviews of a pull request. A review is one run of the review
-- job on one head commit: a finder pass writes the walkthrough and candidate
-- findings, then a refuter pass checks each finding against the diff and
-- drops the ones it cannot confirm. Dropped findings are kept (refuted = 1)
-- with the refuter's reason, so a false alarm can be looked at later.
CREATE TABLE reviews (
    id               TEXT PRIMARY KEY,
    pull_request_id  TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    job_id           TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    requested_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    head_sha         TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    stage            TEXT NOT NULL DEFAULT 'queued',
    walkthrough      TEXT NOT NULL DEFAULT '',
    backend          TEXT,
    model            TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    finished_at      TEXT
);

CREATE INDEX reviews_pull_idx ON reviews (pull_request_id, created_at DESC);

CREATE TABLE findings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id      TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    severity       TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
    path           TEXT NOT NULL DEFAULT '',
    line           INTEGER,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    suggested_fix  TEXT NOT NULL DEFAULT '',
    spec           TEXT,
    refuted        INTEGER NOT NULL DEFAULT 0 CHECK (refuted IN (0, 1)),
    refuter_note   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX findings_review_idx ON findings (review_id);
