-- DropIndex
DROP INDEX "Client_parentId_idx";

-- DropIndex
DROP INDEX "ProcurementWatch_state_lastCheckedAt_idx";

-- CreateTable
CREATE TABLE "ConnectionTest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "onPrem" BOOLEAN NOT NULL DEFAULT false,
    "secretNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "assignedAgentId" TEXT,

    CONSTRAINT "ConnectionTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectionTest_status_idx" ON "ConnectionTest"("status");

-- CreateIndex
CREATE INDEX "ConnectionTest_clientId_idx" ON "ConnectionTest"("clientId");

-- AddForeignKey
ALTER TABLE "ConnectionTest" ADD CONSTRAINT "ConnectionTest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
