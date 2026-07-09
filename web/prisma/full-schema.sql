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

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'global_admin', 'ops_manager', 'engineer', 'importer', 'auditor');

-- CreateEnum
CREATE TYPE "AuthType" AS ENUM ('local', 'sso', 'both');

-- CreateEnum
CREATE TYPE "ClientAccessMode" AS ENUM ('all', 'only', 'exclude');

-- CreateEnum
CREATE TYPE "ClientAccessKind" AS ENUM ('scope', 'grant');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "domains" TEXT[],
    "emailDomain" TEXT,
    "emailDomainLocked" BOOLEAN NOT NULL DEFAULT false,
    "editedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backbone" "Backbone",
    "pod" TEXT,
    "parentId" TEXT,
    "identity" JSONB,
    "personas" JSONB,
    "globals" JSONB,
    "globalsOffboard" JSONB,
    "locations" JSONB,
    "adObjects" JSONB,
    "adDiscoverRequestedAt" TIMESTAMP(3),
    "cloudGroups" JSONB,
    "cloudGroupsRequestedAt" TIMESTAMP(3),
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "intakeSource" TEXT NOT NULL DEFAULT 'um',
    "restricted" BOOLEAN NOT NULL DEFAULT false,
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
    "semver" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updateRequested" BOOLEAN NOT NULL DEFAULT false,
    "updateRequestedAt" TIMESTAMP(3),
    "updateRequestedBy" TEXT,
    "updateDeliveredAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionTest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "systemKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "accessOk" BOOLEAN,
    "accessDetail" TEXT,
    "onPrem" BOOLEAN NOT NULL DEFAULT false,
    "secretNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "assignedAgentId" TEXT,

    CONSTRAINT "ConnectionTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "action" "Action" NOT NULL,
    "serviceNowCaseNumber" TEXT,
    "subject" TEXT,
    "status" "CaseStatus" NOT NULL DEFAULT 'queued',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "secretOverrides" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

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
    "singleRun" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB,
    "evidence" JSONB,
    "validation" JSONB,
    "progress" JSONB,
    "progressAt" TIMESTAMP(3),
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementWatch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'watching',
    "note" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementWatch_pkey" PRIMARY KEY ("id")
);

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
    "kbArticle" TEXT,
    "artifacts" JSONB,

    CONSTRAINT "RunbookSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT,
    "caseRequestId" TEXT,
    "jobId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

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
    "fingerprint" TEXT NOT NULL DEFAULT '',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "RunOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'auditor',
    "status" TEXT NOT NULL DEFAULT 'active',
    "authType" "AuthType" NOT NULL DEFAULT 'local',
    "passwordHash" TEXT,
    "isBreakGlass" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "entraOid" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "clientAccessMode" "ClientAccessMode" NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserClientAccess" (
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ClientAccessKind" NOT NULL,

    CONSTRAINT "UserClientAccess_pkey" PRIMARY KEY ("userId","clientId","kind")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
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

-- CreateIndex
CREATE INDEX "Agent_deletedAt_idx" ON "Agent"("deletedAt");

-- CreateIndex
CREATE INDEX "ConnectionTest_status_idx" ON "ConnectionTest"("status");

-- CreateIndex
CREATE INDEX "ConnectionTest_clientId_idx" ON "ConnectionTest"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseRequest_serviceNowCaseNumber_key" ON "CaseRequest"("serviceNowCaseNumber");

-- CreateIndex
CREATE INDEX "CaseRequest_deletedAt_idx" ON "CaseRequest"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementWatch_jobId_key" ON "ProcurementWatch"("jobId");

-- CreateIndex
CREATE INDEX "RunbookSection_clientId_action_seq_idx" ON "RunbookSection"("clientId", "action", "seq");

-- CreateIndex
CREATE INDEX "AuditLog_userId_at_idx" ON "AuditLog"("userId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "RunOutcome_systemKey_verdict_at_idx" ON "RunOutcome"("systemKey", "verdict", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_clientId_at_idx" ON "RunOutcome"("clientId", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_verdict_at_idx" ON "RunOutcome"("verdict", "at");

-- CreateIndex
CREATE INDEX "RunOutcome_at_idx" ON "RunOutcome"("at");

-- CreateIndex
CREATE INDEX "RunOutcome_fingerprint_idx" ON "RunOutcome"("fingerprint");

-- CreateIndex
CREATE INDEX "RunOutcome_resolvedAt_idx" ON "RunOutcome"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_entraOid_key" ON "User"("entraOid");

-- CreateIndex
CREATE INDEX "UserClientAccess_clientId_idx" ON "UserClientAccess"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSystem" ADD CONSTRAINT "ClientSystem_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSystem" ADD CONSTRAINT "ClientSystem_systemKey_fkey" FOREIGN KEY ("systemKey") REFERENCES "SystemCatalog"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionTest" ADD CONSTRAINT "ConnectionTest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRequest" ADD CONSTRAINT "CaseRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_caseRequestId_fkey" FOREIGN KEY ("caseRequestId") REFERENCES "CaseRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementWatch" ADD CONSTRAINT "ProcurementWatch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunbookSection" ADD CONSTRAINT "RunbookSection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClientAccess" ADD CONSTRAINT "UserClientAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClientAccess" ADD CONSTRAINT "UserClientAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

