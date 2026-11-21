-- T0.8: GitHub sign-in (ports the Postgres migration of T0.4). Users are keyed
-- by their GitHub id; sessions hold only a SHA-256 (hex) of the cookie token,
-- never the token itself. Ids are UUID strings, timestamps are ISO 8601 UTC
-- TEXT, so string comparison orders them.
CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    github_id   INTEGER NOT NULL UNIQUE,
    login       TEXT NOT NULL,
    name        TEXT,
    avatar_url  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
