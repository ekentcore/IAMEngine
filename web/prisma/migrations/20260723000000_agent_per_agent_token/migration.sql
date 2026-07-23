-- Per-agent runner auth: additive, all nullable, no backfill.
ALTER TABLE "Agent" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenPrefix" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenProvisionedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRotatedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN "tokenRefreshDeliveredAt" TIMESTAMP(3);
CREATE INDEX "Agent_tokenPrefix_idx" ON "Agent"("tokenPrefix");
