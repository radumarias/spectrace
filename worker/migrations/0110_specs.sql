-- T4.4: what the index job reads from the spec files and the code of a repo.
-- Every index of a repo replaces its rows; a spec keeps its id while its path
-- stays the same, so links to it survive a re-index.
--
-- A spec file is a Markdown file under a folder named `spec` (docs/spec-format.md).
-- `root` is the folder that holds that `spec` folder ('' at the top of the
-- repo) and `area` the folders between `spec/` and the file ('' when flat),
-- which the app map groups by. `model` is the parsed spec as JSON (the core's
-- `Spec`), NULL when the file has errors; `diagnostics` is always set.
CREATE TABLE specs (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repo_id            TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
    path               TEXT NOT NULL,
    root               TEXT NOT NULL,
    area               TEXT NOT NULL,
    flow               TEXT NOT NULL,
    title              TEXT NOT NULL,
    source             TEXT NOT NULL,
    model              TEXT,
    diagnostics        TEXT NOT NULL DEFAULT '[]',
    step_count         INTEGER NOT NULL DEFAULT 0,
    requirement_count  INTEGER NOT NULL DEFAULT 0,
    tested_count       INTEGER NOT NULL DEFAULT 0,
    sha                TEXT,
    indexed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (repo_id, path)
);

CREATE INDEX specs_project_id_idx ON specs (project_id, path);

-- The diagram's arrows, one row per edge (an edge is its source, label and target).
CREATE TABLE spec_edges (
    spec_id    TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    from_node  TEXT NOT NULL,
    label      TEXT NOT NULL,
    to_node    TEXT NOT NULL,
    PRIMARY KEY (spec_id, from_node, label, to_node)
);

-- `#[spec("…")]` attributes and `@flow` comments found in code and tests.
-- `spec_id` is the spec the anchor's id belongs to (same repo, nearest spec
-- root), NULL when no spec has that flow. `excerpt` is the anchored item's
-- source, a few dozen lines at most, for the spec page's code view.
CREATE TABLE anchors (
    id         INTEGER PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES project_repos(id) ON DELETE CASCADE,
    spec_id    TEXT REFERENCES specs(id) ON DELETE SET NULL,
    path       TEXT NOT NULL,
    line       INTEGER NOT NULL,
    language   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('spec', 'flow')),
    class      TEXT NOT NULL CHECK (class IN ('code', 'test')),
    target     TEXT NOT NULL,
    note       TEXT,
    excerpt    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX anchors_repo_id_idx ON anchors (repo_id);
CREATE INDEX anchors_spec_id_idx ON anchors (spec_id, target);
