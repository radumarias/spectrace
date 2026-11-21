-- Per-file diffs: GitHub's unified diff for each changed file, copied by the
-- sync job. NULL when GitHub sends none (binary files, or a diff it considers
-- too large) or when it is over our size cap.
ALTER TABLE pr_files ADD COLUMN patch TEXT;
-- Files already stored have no patches; make the next sync read them again.
UPDATE pull_requests SET files_sha = NULL WHERE state = 'open';
