-- Operator-requested plain restart (no file pull) for a supervised runner.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "restartRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "restartRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "restartRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "restartDeliveredAt" TIMESTAMP(3);
