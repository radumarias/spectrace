-- GitLab: each spectrace user may connect one account on the server's GitLab
-- instance (GITLAB_URL), through its OAuth application or with a personal
-- access token. spectrace reads and writes that user's GitLab repositories
-- with it. Tokens are sealed with AES-GCM under SECRETS_KEY (src/user-keys.ts),
-- never stored or returned in the clear.
CREATE TABLE gitlab_connections (
    user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    gitlab_user_id  INTEGER NOT NULL,
    username        TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
    access_token    TEXT NOT NULL,
    refresh_token   TEXT,
    expires_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
