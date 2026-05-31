-- CreateEnum
CREATE TYPE "Backbone" AS ENUM ('entra', 'google', 'ad_synced', 'ad_standalone');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "Mode" AS ENUM ('api', 'browser', 'manual');

-- CreateEnum
CREATE TYPE "Lifecycle" AS ENUM ('always', 'on_request', 'never');

-- CreateEnum
CREATE TYPE "Action" AS ENUM ('onboard', 'offboard');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('queued', 'planning', 'running', 'needs_manual', 'needs_approval', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'dispatched', 'running', 'succeeded', 'failed', 'manual', 'skipped');

-- CreateEnum
CREATE TYPE "AgentScope" AS ENUM ('central', 'client_network');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "domains" TEXT[],
    "backbone" "Backbone",
    "pod" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "serviceNowSysId" TEXT,
    "coreId" TEXT,
    "region" TEXT,
    "timezone" TEXT,
    "supportStatus" TEXT,
    "coManaged" BOOLEAN NOT NULL DEFAULT false,
    "onboardingRating" INTEGER,
    "offboardingRating" INTEGER,
    "snLastSyncedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemCatalog" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultMode" "Mode" NOT NULL DEFAULT 'api',
    "supportsOnboard" BOOLEAN NOT NULL DEFAULT true,
    "supportsOffboard" BOOLEAN NOT NULL DEFAULT true,
    "moduleName" TEXT,
    "buildTier" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "SystemCatalog_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ClientSystem" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "mode" "Mode" NOT NULL,
    "onboardWhen" "Lifecycle" NOT NULL DEFAULT 'never',
    "offboardWhen" "Lifecycle" NOT NULL DEFAULT 'never',
    "dependsOn" TEXT[],
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "captureEvidence" BOOLEAN NOT NULL DEFAULT false,
    "secretNames" TEXT[],
    "config" JSONB,

    CONSTRAINT "ClientSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'delinea',
    "externalId" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "scope" "AgentScope" NOT NULL,
    "version" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "action" "Action" NOT NULL,
    "serviceNowCaseNumber" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "caseRequestId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "mode" "Mode" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "assignedAgentId" TEXT,
    "request" JSONB,
    "result" JSONB,
    "evidence" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "clientId" TEXT,
    "caseRequestId" TEXT,
    "jobId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_slug_key" ON "Client"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Client_serviceNowSysId_key" ON "Client"("serviceNowSysId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_coreId_key" ON "Client"("coreId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientSystem_clientId_systemKey_key" ON "ClientSystem"("clientId", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_clientId_name_key" ON "Secret"("clientId", "name");

-- AddForeignKey
ALTER TABLE "ClientSystem" ADD CONSTRAINT "ClientSystem_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSystem" ADD CONSTRAINT "ClientSystem_systemKey_fkey" FOREIGN KEY ("systemKey") REFERENCES "SystemCatalog"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRequest" ADD CONSTRAINT "CaseRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_caseRequestId_fkey" FOREIGN KEY ("caseRequestId") REFERENCES "CaseRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
