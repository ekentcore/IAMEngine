-- Fleet-wide M365 sweeps (permission gaps, leaked seats) and their findings.
-- Additive + idempotent: a new table and its index, nothing else touched.
CREATE TABLE IF NOT EXISTS "FleetAudit" (
    "id"         TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'running',
    "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedBy"  TEXT,
    "scanned"    INTEGER NOT NULL DEFAULT 0,
    "total"      INTEGER NOT NULL DEFAULT 0,
    "findings"   JSONB,
    "error"      TEXT,
    CONSTRAINT "FleetAudit_pkey" PRIMARY KEY ("id")
);

-- "the latest run of this kind" is the only query this table serves.
CREATE INDEX IF NOT EXISTS "FleetAudit_kind_startedAt_idx" ON "FleetAudit"("kind", "startedAt");
