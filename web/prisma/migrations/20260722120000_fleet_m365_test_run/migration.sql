-- Fleet-wide M365-family connection-test sweep record. Additive + idempotent: one new table.
-- Per-client/per-system state is NOT stored here — it lives in ConnectionTest; this row is the
-- sweep's concurrency guard + "is a sweep running" signal.
CREATE TABLE IF NOT EXISTS "FleetM365TestRun" (
    "id"         TEXT NOT NULL,
    "scope"      TEXT NOT NULL DEFAULT 'fleet-m365',
    "status"     TEXT NOT NULL DEFAULT 'running',
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy"  TEXT,
    "total"      INTEGER NOT NULL DEFAULT 0,
    "clients"    INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "FleetM365TestRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FleetM365TestRun_scope_startedAt_idx" ON "FleetM365TestRun"("scope", "startedAt");

-- At most one running sweep per scope — the atomic backstop for the "one live run" guard.
-- Raw partial index: Prisma schema can't express a WHERE-clause partial unique, so this stays
-- migration-only and is intentionally NOT mirrored in schema.prisma. Mirrors
-- M365SetupRun_one_running_per_scope.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetM365TestRun_one_running_per_scope"
  ON "FleetM365TestRun"("scope") WHERE "status" = 'running';
