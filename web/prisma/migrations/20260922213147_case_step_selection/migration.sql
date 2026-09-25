-- AlterTable
ALTER TABLE "CaseRequest" ADD COLUMN     "requestedSystems" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "skippedSystems" TEXT[] DEFAULT ARRAY[]::TEXT[];

