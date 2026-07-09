-- AlterTable
ALTER TABLE "CaseRequest" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "CaseRequest_deletedAt_idx" ON "CaseRequest"("deletedAt");
