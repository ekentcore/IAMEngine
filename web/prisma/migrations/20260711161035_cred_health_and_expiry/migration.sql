-- AlterTable
ALTER TABLE "Secret" ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "expiryCheckedAt" TIMESTAMP(3),
ADD COLUMN "expiryNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConnHealthState" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "lastDetail" TEXT,
    "lastOkAt" TIMESTAMP(3),
    "lastFailAt" TIMESTAMP(3),
    "credExpiresAt" TIMESTAMP(3),
    "pendingNotifyAt" TIMESTAMP(3),
    "failNotifiedAt" TIMESTAMP(3),
    "expiryNotifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnHealthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnHealthState_clientId_systemKey_key" ON "ConnHealthState"("clientId", "systemKey");

-- CreateIndex
CREATE INDEX "ConnHealthState_pendingNotifyAt_idx" ON "ConnHealthState"("pendingNotifyAt");

-- AddForeignKey
ALTER TABLE "ConnHealthState" ADD CONSTRAINT "ConnHealthState_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
