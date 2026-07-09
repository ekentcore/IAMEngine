-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "cloudGroups" JSONB,
ADD COLUMN     "cloudGroupsRequestedAt" TIMESTAMP(3);
