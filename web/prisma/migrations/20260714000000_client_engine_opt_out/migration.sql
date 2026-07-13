-- Per-client "do not use engine" flag: the intake sweep / manual import skip this client's
-- ServiceNow cases entirely (cases already imported are untouched).
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "engineOptOut" BOOLEAN NOT NULL DEFAULT false;
