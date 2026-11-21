-- T1.6: what the index job records for each repository. `index_state` (0020)
-- already tracks pending / indexing / ready / failed; these columns hold the
-- result. Languages is GitHub's map of language to bytes, as JSON text.
ALTER TABLE project_repos ADD COLUMN languages TEXT NOT NULL DEFAULT '{}';
ALTER TABLE project_repos ADD COLUMN file_count INTEGER;
ALTER TABLE project_repos ADD COLUMN tree_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_repos ADD COLUMN head_sha TEXT;
ALTER TABLE project_repos ADD COLUMN indexed_at TEXT;
ALTER TABLE project_repos ADD COLUMN index_error TEXT;
