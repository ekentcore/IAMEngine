-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "googleOus" JSONB,
ADD COLUMN     "googleOusRequestedAt" TIMESTAMP(3),
ADD COLUMN     "googleOusRequestedById" TEXT;

