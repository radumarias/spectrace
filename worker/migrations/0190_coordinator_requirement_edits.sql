-- Requirements studio, phase 3: the coordinator revises the requirements set
-- the user is on. `req_edit` is JSON {setId, changes, skipped, before: {title,
-- flows, views, ids}, at, undone}, like `board` for whiteboards: the set
-- before the change, kept so one click undoes it while nobody changed it since.
ALTER TABLE coordinator_messages ADD COLUMN req_edit TEXT;
