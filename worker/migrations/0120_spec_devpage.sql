-- Each spec's devpage server document (src/devpage.ts): its id, the latest
-- version published, and the SHA-256 of the source that version was made from,
-- so an index publishes only the specs that changed.
ALTER TABLE specs ADD COLUMN devpage_id TEXT;
ALTER TABLE specs ADD COLUMN devpage_version INTEGER;
ALTER TABLE specs ADD COLUMN devpage_hash TEXT;
CREATE INDEX specs_devpage ON specs (devpage_id);
