-- CreateTable
CREATE TABLE "UniversalChoice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "snSysId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "m365Groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "googleGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "goneAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalChoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UniversalChoice_clientId_question_idx" ON "UniversalChoice"("clientId", "question");

-- CreateIndex
CREATE UNIQUE INDEX "UniversalChoice_clientId_snSysId_key" ON "UniversalChoice"("clientId", "snSysId");

-- AddForeignKey
ALTER TABLE "UniversalChoice" ADD CONSTRAINT "UniversalChoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
