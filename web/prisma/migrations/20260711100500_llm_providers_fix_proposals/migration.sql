-- Fix lane v2: LLM provider registry + on-screen fix proposals.

-- AlterTable: proposal payload + provider snapshot + apply attribution.
ALTER TABLE "FixTask" ADD COLUMN "proposal" JSONB,
ADD COLUMN "provider" TEXT,
ADD COLUMN "appliedBy" TEXT,
ADD COLUMN "appliedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LlmProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmProvider_pkey" PRIMARY KEY ("id")
);

-- The one-unfinished-task-per-fingerprint guard must also cover the new 'applying' state, so a
-- fingerprint being applied can't be re-analyzed in parallel (partial unique = raw SQL, as before).
DROP INDEX "FixTask_active_fingerprint_key";
CREATE UNIQUE INDEX "FixTask_active_fingerprint_key" ON "FixTask"("fingerprint") WHERE "status" IN ('queued', 'running', 'applying');
