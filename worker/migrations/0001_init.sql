-- Baseline migration. Later tasks add their own tables, one migration each.
CREATE TABLE app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO app_meta (key, value) VALUES ('schema', 'spectrace');
