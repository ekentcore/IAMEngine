-- CreateTable
CREATE TABLE "GoogleSetupRun" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "GoogleSetupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleSetupRunClient" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "saEmail" TEXT,
    "saClientId" TEXT,
    "verified" BOOLEAN,
    "wroteCreds" BOOLEAN,
    "skipReason" TEXT,
    "error" TEXT,
    "warnings" TEXT[],
    "userAction" JSONB,
    "log" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleSetupRunClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleSetupRun_scope_startedAt_idx" ON "GoogleSetupRun"("scope", "startedAt");

-- CreateIndex
CREATE INDEX "GoogleSetupRunClient_runId_idx" ON "GoogleSetupRunClient"("runId");

-- AddForeignKey
ALTER TABLE "GoogleSetupRunClient" ADD CONSTRAINT "GoogleSetupRunClient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GoogleSetupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
