-- T1.2: GitHub App installations. One row per installation of the app; the
-- link table says which spectrace users may use it. Installation tokens are
-- short-lived and kept in memory, never in the database.
CREATE TABLE github_installations (
    id                    INTEGER PRIMARY KEY,           -- GitHub's installation id
    account_id            INTEGER NOT NULL,
    account_login         TEXT NOT NULL,
    account_type          TEXT NOT NULL,                 -- 'User' or 'Organization'
    repository_selection  TEXT NOT NULL,                 -- 'all' or 'selected'
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE user_installations (
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id  INTEGER NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, installation_id)
);

CREATE INDEX user_installations_installation_idx ON user_installations (installation_id);
