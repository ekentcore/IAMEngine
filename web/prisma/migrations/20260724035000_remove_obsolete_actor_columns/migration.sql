-- Remove obsolete actor columns that are no longer represented
-- in the current Prisma schema.

ALTER TABLE "ConnectionTest"
  DROP COLUMN IF EXISTS "requestedById";

ALTER TABLE "GoogleSetupRun"
  DROP COLUMN IF EXISTS "startedById";

ALTER TABLE "M365SetupRun"
  DROP COLUMN IF EXISTS "startedById";