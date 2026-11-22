-- Each user's own Anthropic API key, so their agent work is billed to them.
-- The key is stored encrypted (AES-GCM with the Worker secret SECRETS_KEY,
-- see worker/src/user-keys.ts); `hint` is its last four characters for display.
-- Claude subscription tokens are never stored: Anthropic's terms forbid apps
-- collecting them.
CREATE TABLE user_claude_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cipher TEXT NOT NULL,
  hint TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
