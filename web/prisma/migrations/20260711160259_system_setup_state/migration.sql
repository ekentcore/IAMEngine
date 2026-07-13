-- CreateTable
CREATE TABLE "SystemSetupState" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "startedBy" TEXT,
    "attestedAt" TIMESTAMP(3),
    "attestedBy" TEXT,
    "attestNote" TEXT,

    CONSTRAINT "SystemSetupState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetupState_clientId_systemKey_key" ON "SystemSetupState"("clientId", "systemKey");

-- AddForeignKey
ALTER TABLE "SystemSetupState" ADD CONSTRAINT "SystemSetupState_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
