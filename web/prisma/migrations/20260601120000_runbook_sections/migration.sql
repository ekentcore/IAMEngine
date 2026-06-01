-- CreateTable
CREATE TABLE "RunbookSection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "action" "Action" NOT NULL,
    "seq" INTEGER NOT NULL,
    "systemKey" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "guess" TEXT,
    "steps" TEXT[],

    CONSTRAINT "RunbookSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunbookSection_clientId_action_seq_idx" ON "RunbookSection"("clientId", "action", "seq");

-- AddForeignKey
ALTER TABLE "RunbookSection" ADD CONSTRAINT "RunbookSection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
