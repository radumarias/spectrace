-- T1.1: projects and the repositories attached to them. A project belongs to
-- one user (its owner); only the owner can see or change it.
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    context     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_owner_id_idx ON projects (owner_id, created_at);

CREATE TABLE project_repos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    github_repo_id  BIGINT,
    full_name       TEXT NOT NULL,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    index_state     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (index_state IN ('pending', 'indexing', 'ready', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, full_name)
);

CREATE INDEX project_repos_project_id_idx ON project_repos (project_id);
