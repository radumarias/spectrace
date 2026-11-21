-- T2.1: pull requests and their changed files, copied from GitHub by the
-- "sync" job. One row per PR per project repo; `number` is the PR number in
-- that repo. Rows are replaced on every sync, so they are a cache of GitHub,
-- never the source of truth.
CREATE TABLE pull_requests (
    id                TEXT PRIMARY KEY,
    repo_id           TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
    number            INTEGER NOT NULL,
    github_pr_id      INTEGER NOT NULL,
    title             TEXT NOT NULL,
    body              TEXT NOT NULL DEFAULT '',
    author_login      TEXT NOT NULL DEFAULT '',
    state             TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    draft             INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
    head_ref          TEXT NOT NULL,
    head_sha          TEXT NOT NULL,
    base_ref          TEXT NOT NULL,
    html_url          TEXT NOT NULL,
    additions         INTEGER NOT NULL DEFAULT 0,
    deletions         INTEGER NOT NULL DEFAULT 0,
    changed_files     INTEGER NOT NULL DEFAULT 0,
    github_created_at TEXT NOT NULL,
    github_updated_at TEXT NOT NULL,
    synced_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (repo_id, number)
);

CREATE INDEX pull_requests_repo_state_idx ON pull_requests (repo_id, state, number DESC);

CREATE TABLE pr_files (
    pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    status          TEXT NOT NULL,   -- GitHub's: added, removed, modified, renamed, copied, changed, unchanged
    previous_path   TEXT,            -- set when renamed
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pull_request_id, path)
);
