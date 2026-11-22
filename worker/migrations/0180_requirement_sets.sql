-- Requirements studio, phase 2: requirements drafted from a whiteboard and
-- its discussion. `flows` is a JSON array of {flow, title, source}: spec-format
-- files with their stable step and requirement ids. `views` is a JSON array
-- of {id, of, kind, title, text}: mockups, other diagrams and notes, each
-- illustrating an id (`of`) or the whole set. `ids` is every id the set has
-- ever issued, so an id that is removed is never handed out again.
CREATE TABLE requirement_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  flows TEXT NOT NULL DEFAULT '[]',
  views TEXT NOT NULL DEFAULT '[]',
  ids TEXT NOT NULL DEFAULT '[]',
  backend TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX requirement_sets_project ON requirement_sets (project_id, updated_at);
