-- T1.1: projects and the repositories attached to them. A project belongs to
-- one user (its owner); only the owner can see or change it. Ids are UUID
-- strings, timestamps ISO 8601 UTC TEXT.
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    context     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX projects_owner_id_idx ON projects (owner_id, created_at);

CREATE TABLE project_repos (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    github_repo_id  INTEGER,
    full_name       TEXT NOT NULL COLLATE NOCASE,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    index_state     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (index_state IN ('pending', 'indexing', 'ready', 'failed')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, full_name)
);

CREATE INDEX project_repos_project_id_idx ON project_repos (project_id);
