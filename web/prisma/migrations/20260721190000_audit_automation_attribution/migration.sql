-- Attribute runner/background RESULTS to the user who kicked them off (rendered "Name (Automation)").
-- Persist the initiating user at request/start time so the async result audit can carry userId.
ALTER TABLE "ConnectionTest" ADD COLUMN IF NOT EXISTS "requestedById" TEXT;
ALTER TABLE "M365SetupRun" ADD COLUMN IF NOT EXISTS "startedById" TEXT;
ALTER TABLE "GoogleSetupRun" ADD COLUMN IF NOT EXISTS "startedById" TEXT;
