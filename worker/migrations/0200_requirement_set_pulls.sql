-- Requirements studio, phase 4: the pull request that added a requirements
-- set's spec files (and views) to a repository.
ALTER TABLE requirement_sets ADD COLUMN pull_repo TEXT;
ALTER TABLE requirement_sets ADD COLUMN pull_number INTEGER;
ALTER TABLE requirement_sets ADD COLUMN pull_url TEXT;
