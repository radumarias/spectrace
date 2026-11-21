-- T2.6: reviews the signed-in user left from spectrace (approve / request
-- changes), kept so the inbox can leave out PRs you already approved. The
-- review itself lives on GitHub; `head_sha` is the commit it was left on, so
-- a push after an approval puts the PR back under "Needs you".
CREATE TABLE pull_reviews (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pull_request_id  TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verdict          TEXT NOT NULL CHECK (verdict IN ('approved', 'changes_requested')),
    body             TEXT NOT NULL DEFAULT '',
    head_sha         TEXT NOT NULL,
    github_review_id INTEGER,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX pull_reviews_pr_user_idx ON pull_reviews (pull_request_id, user_id, id DESC);
