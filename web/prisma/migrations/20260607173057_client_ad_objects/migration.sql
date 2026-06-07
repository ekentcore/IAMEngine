-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "adDiscoverRequestedAt" TIMESTAMP(3),
ADD COLUMN     "adObjects" JSONB;
