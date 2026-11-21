-- T2.3: the inbox has a "Merged" view. `state` stays open/closed (the sync job
-- only lists open PRs); a closed PR that GitHub says was merged gets its time here.
ALTER TABLE pull_requests ADD COLUMN merged_at TEXT;

CREATE INDEX pull_requests_merged_idx ON pull_requests (repo_id, merged_at) WHERE merged_at IS NOT NULL;
