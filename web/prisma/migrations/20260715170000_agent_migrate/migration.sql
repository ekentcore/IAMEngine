-- Operator-driven app-URL self-migration: the agent reports its current base URL, gets a new target,
-- verifies it, rewrites its supervisor entry, and switches. All additive + idempotent.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "currentAppUrl" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateDeliveredAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migratedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateError" TEXT;
