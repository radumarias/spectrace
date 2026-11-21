-- T2.2: what GitHub webhooks add to a stored pull request.
--
-- `files_sha` is the head commit that `pr_files` was read for. Webhooks move
-- `head_sha` right away but never read files, so the sync job compares
-- `files_sha` (not `head_sha`) to decide whether to fetch a PR's files again.
ALTER TABLE pull_requests ADD COLUMN files_sha TEXT;
UPDATE pull_requests SET files_sha = head_sha;

-- Submitted reviews (pull_request_review events), one row per GitHub review.
-- `state` is GitHub's, lower-cased: approved, changes_requested, commented, dismissed.
CREATE TABLE pr_reviews (
    pull_request_id  TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    github_review_id INTEGER NOT NULL,
    reviewer_login   TEXT NOT NULL DEFAULT '',
    state            TEXT NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    commit_sha       TEXT NOT NULL DEFAULT '',
    submitted_at     TEXT NOT NULL,
    PRIMARY KEY (pull_request_id, github_review_id)
);

-- Check suites (check_suite events) per repo. A PR's checks are the suites
-- whose `head_sha` equals its own, so a suite can arrive before its PR does.
CREATE TABLE pr_check_suites (
    repo_id               TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
    github_check_suite_id INTEGER NOT NULL,
    head_sha              TEXT NOT NULL,
    app_name              TEXT NOT NULL DEFAULT '',
    status                TEXT NOT NULL,   -- queued, in_progress, completed
    conclusion            TEXT,            -- success, failure, neutral, cancelled, skipped, timed_out, action_required, stale; null until completed
    updated_at            TEXT NOT NULL,
    PRIMARY KEY (repo_id, github_check_suite_id)
);

CREATE INDEX pr_check_suites_head_idx ON pr_check_suites (repo_id, head_sha);
