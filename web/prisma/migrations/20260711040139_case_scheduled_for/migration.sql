-- AlterTable
ALTER TABLE "CaseRequest" ADD COLUMN     "scheduledBy" TEXT,
ADD COLUMN     "scheduledFor" TIMESTAMP(3);
