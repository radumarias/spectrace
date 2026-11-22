-- The coordinator chat (T7.1): one conversation per user and project.
-- `tools` is a JSON array of the read tools the coordinator called for this
-- reply, shown under it ("pulls.list(filter=needs)"). `actions` is a JSON
-- array of the actions it proposes; nothing runs until the user clicks one,
-- and `ran` records which ones did (JSON array of indexes).
CREATE TABLE coordinator_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'coordinator')),
  text TEXT NOT NULL,
  screen TEXT,
  tools TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  ran TEXT NOT NULL DEFAULT '[]',
  backend TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX coordinator_messages_thread ON coordinator_messages (project_id, user_id, created_at);
