-- Whiteboards (T5.7): a project's sketches, as an ordered list of blocks
-- (Markdown notes and Mermaid diagrams) kept as one JSON array.
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  blocks TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX boards_project ON boards (project_id, updated_at);
