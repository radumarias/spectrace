-- CI check runs (the individual jobs a PR's checks list is made of), per
-- repo and commit. Filled by the `check_run` webhook and by the sync job; a
-- PR shows the runs whose `head_sha` equals its own, so a run can arrive
-- before its PR does. `status` is GitHub's (queued, in_progress, completed);
-- `conclusion` is null until completed.
CREATE TABLE pr_check_runs (
    repo_id             TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
    github_check_run_id INTEGER NOT NULL,
    head_sha            TEXT NOT NULL,
    name                TEXT NOT NULL,
    status              TEXT NOT NULL,
    conclusion          TEXT,
    html_url            TEXT NOT NULL DEFAULT '',
    started_at          TEXT,
    completed_at        TEXT,
    PRIMARY KEY (repo_id, github_check_run_id)
);

CREATE INDEX pr_check_runs_head_idx ON pr_check_runs (repo_id, head_sha);
