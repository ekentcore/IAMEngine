-- Auth: operators (User), live sessions (Session), per-user audit (AuditLog.userId).
CREATE TYPE "Role" AS ENUM ('global_admin', 'ops_manager', 'engineer', 'importer', 'auditor');
CREATE TYPE "AuthType" AS ENUM ('local', 'sso', 'both');

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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_entraOid_key" ON "User"("entraOid");

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
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD COLUMN "userId" TEXT;
CREATE INDEX "AuditLog_userId_at_idx" ON "AuditLog"("userId", "at");
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
