-- Git providers: a project repository lives on GitHub (every repo so far) or
-- on a GitLab instance. `full_name` is GitHub's owner/name, or GitLab's
-- path with namespace (group/subgroup/name).
ALTER TABLE project_repos ADD COLUMN provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab'));
