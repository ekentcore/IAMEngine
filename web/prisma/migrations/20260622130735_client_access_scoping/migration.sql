-- CreateEnum
CREATE TYPE "ClientAccessMode" AS ENUM ('all', 'only', 'exclude');

-- CreateEnum
CREATE TYPE "ClientAccessKind" AS ENUM ('scope', 'grant');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "clientAccessMode" "ClientAccessMode" NOT NULL DEFAULT 'all';

-- CreateTable
CREATE TABLE "UserClientAccess" (
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ClientAccessKind" NOT NULL,

    CONSTRAINT "UserClientAccess_pkey" PRIMARY KEY ("userId","clientId","kind")
);

-- CreateIndex
CREATE INDEX "UserClientAccess_clientId_idx" ON "UserClientAccess"("clientId");

-- AddForeignKey
ALTER TABLE "UserClientAccess" ADD CONSTRAINT "UserClientAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClientAccess" ADD CONSTRAINT "UserClientAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
