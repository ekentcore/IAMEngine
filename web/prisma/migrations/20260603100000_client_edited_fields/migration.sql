-- Track which client fields were hand-edited in the UI, so routine ServiceNow sync skips them
-- (a "hard refresh" clears the list and overwrites from ServiceNow).
ALTER TABLE "Client" ADD COLUMN "editedFields" TEXT[] NOT NULL DEFAULT '{}';
