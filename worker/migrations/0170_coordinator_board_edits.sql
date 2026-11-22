-- Requirements studio, phase 1: the coordinator draws on the whiteboard the
-- user is on. `board` is JSON {boardId, changes, before: {title, blocks},
-- at, undone}: the board before the coordinator's change, kept so one click
-- undoes it, and `at` the board's updated_at right after the change (undo
-- only runs while the board is still as the coordinator left it).
ALTER TABLE coordinator_messages ADD COLUMN board TEXT;
