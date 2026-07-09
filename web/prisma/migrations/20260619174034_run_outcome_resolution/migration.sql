-- AlterTable
ALTER TABLE "RunOutcome" ADD COLUMN     "fingerprint" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" TEXT;

-- CreateIndex
CREATE INDEX "RunOutcome_fingerprint_idx" ON "RunOutcome"("fingerprint");

-- CreateIndex
CREATE INDEX "RunOutcome_resolvedAt_idx" ON "RunOutcome"("resolvedAt");
