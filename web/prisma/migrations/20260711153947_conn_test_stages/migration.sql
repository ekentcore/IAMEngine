-- AlterTable
ALTER TABLE "ConnectionTest" ADD COLUMN "fieldsOk" BOOLEAN,
ADD COLUMN "fieldsDetail" TEXT,
ADD COLUMN "rights" JSONB,
ADD COLUMN "credExpiresAt" TIMESTAMP(3),
ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
