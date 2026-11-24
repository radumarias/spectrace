-- A structured walkthrough for agent reviews, as the prototype shows it: a
-- short summary, an overall risk with its reason, the change as numbered
-- steps (each with the files, the spec it touches, its impact and a code
-- excerpt), and the questions the reviewer could not settle from the specs.
-- `steps` and `decisions` are JSON arrays. Reviews from before this keep only
-- their Markdown `walkthrough`.
ALTER TABLE reviews ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE reviews ADD COLUMN risk TEXT CHECK (risk IN ('high', 'medium', 'low'));
ALTER TABLE reviews ADD COLUMN risk_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE reviews ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reviews ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]';
