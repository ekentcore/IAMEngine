-- Deep probes on a connection test: expensive/interactive checks (a real browser sign-in to a vendor
-- portal) that only a targeted, operator-initiated single-system retest may run. Additive + defaulted,
-- so existing rows and older app instances are unaffected.
ALTER TABLE "ConnectionTest" ADD COLUMN IF NOT EXISTS "deep" BOOLEAN NOT NULL DEFAULT false;
