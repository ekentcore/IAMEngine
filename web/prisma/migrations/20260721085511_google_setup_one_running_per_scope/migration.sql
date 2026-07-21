-- At most one running GoogleSetupRun per scope — the atomic backstop for the "one live run" guard
-- (a duplicate run here is NOT harmless: it mutates — starts a second OAuth/DWD flow, provisions a
-- second GCP key, writes secrets). Mirrors M365SetupRun_one_running_per_scope.
-- Raw partial index: Prisma schema can't express a WHERE-clause partial unique, so this stays
-- migration-only and is intentionally NOT mirrored in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "GoogleSetupRun_one_running_per_scope"
  ON "GoogleSetupRun"("scope") WHERE "status" = 'running';
