-- M365 auto-setup: persist each client run's full step/error trail (SetupResult.actions) so it can be
-- shown as an expandable run log in the UI and reviewed after the fact, not just while polling live.
-- Additive: one nullable column, nothing else touched.
ALTER TABLE "M365SetupRunClient" ADD COLUMN IF NOT EXISTS "log" TEXT[];
