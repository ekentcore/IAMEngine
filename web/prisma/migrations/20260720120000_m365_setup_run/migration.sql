-- Automated M365 app-registration setup runs: a run (client | fleet) + its per-client outcomes.
-- Additive + idempotent: two new tables, nothing else touched.
CREATE TABLE IF NOT EXISTS "M365SetupRun" (
    "id"         TEXT NOT NULL,
    "scope"      TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'running',
    "dryRun"     BOOLEAN NOT NULL DEFAULT false,
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy"  TEXT,
    "total"      INTEGER NOT NULL DEFAULT 0,
    "completed"  INTEGER NOT NULL DEFAULT 0,
    "succeeded"  INTEGER NOT NULL DEFAULT 0,
    "skipped"    INTEGER NOT NULL DEFAULT 0,
    "failed"     INTEGER NOT NULL DEFAULT 0,
    "error"      TEXT,
    CONSTRAINT "M365SetupRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "M365SetupRunClient" (
    "id"              TEXT NOT NULL,
    "runId"           TEXT NOT NULL,
    "clientId"        TEXT NOT NULL,
    "slug"            TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "stage"           TEXT,
    "appId"           TEXT,
    "wroteCreds"      BOOLEAN,
    "verified"        BOOLEAN,
    "skipReason"      TEXT,
    "error"           TEXT,
    "warnings"        TEXT[],
    "userCode"        TEXT,
    "verificationUri" TEXT,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "M365SetupRunClient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "M365SetupRun_scope_startedAt_idx" ON "M365SetupRun"("scope", "startedAt");
CREATE INDEX IF NOT EXISTS "M365SetupRunClient_runId_idx" ON "M365SetupRunClient"("runId");

ALTER TABLE "M365SetupRunClient"
  ADD CONSTRAINT "M365SetupRunClient_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "M365SetupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one running M365SetupRun per scope — the atomic backstop for the "one live run" guard
-- (a duplicate sweep here is NOT harmless: it mutates — creates app registrations + writes secrets).
-- Raw partial index: Prisma schema can't express a WHERE-clause partial unique, so this stays
-- migration-only and is intentionally NOT mirrored in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "M365SetupRun_one_running_per_scope"
  ON "M365SetupRun"("scope") WHERE "status" = 'running';
