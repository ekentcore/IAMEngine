-- Provenance of module credential setup + a generalized, vendor-agnostic setup-run pair. All additive
-- (new tables only) — no change to existing columns or data.

-- Which Delinea credential set up a given module for a client (one current row per client+module).
CREATE TABLE "ModuleSetupCredential" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "delineaSecretId" TEXT NOT NULL,
    "delineaFolderId" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModuleSetupCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ModuleSetupCredential_clientId_moduleKey_key" ON "ModuleSetupCredential"("clientId", "moduleKey");
CREATE INDEX "ModuleSetupCredential_clientId_idx" ON "ModuleSetupCredential"("clientId");
ALTER TABLE "ModuleSetupCredential" ADD CONSTRAINT "ModuleSetupCredential_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Generalized async setup run, keyed by moduleKey (successor to the per-vendor M365/Google run pairs).
CREATE TABLE "ModuleSetupRun" (
    "id" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy" TEXT,
    "startedById" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    CONSTRAINT "ModuleSetupRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ModuleSetupRun_moduleKey_scope_startedAt_idx" ON "ModuleSetupRun"("moduleKey", "scope", "startedAt");

CREATE TABLE "ModuleSetupRunClient" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "error" TEXT,
    "skipReason" TEXT,
    "warnings" TEXT[],
    "detail" JSONB,
    "log" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ModuleSetupRunClient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ModuleSetupRunClient_runId_idx" ON "ModuleSetupRunClient"("runId");
ALTER TABLE "ModuleSetupRunClient" ADD CONSTRAINT "ModuleSetupRunClient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ModuleSetupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
