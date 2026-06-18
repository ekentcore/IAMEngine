-- CreateTable
CREATE TABLE "RunOutcome" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseRequestId" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "action" "Action" NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messages" TEXT[],
    "error" TEXT,
    "validateOnly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RunOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunOutcome_systemKey_verdict_at_idx" ON "RunOutcome"("systemKey", "verdict", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_clientId_at_idx" ON "RunOutcome"("clientId", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_verdict_at_idx" ON "RunOutcome"("verdict", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_at_idx" ON "RunOutcome"("at");
