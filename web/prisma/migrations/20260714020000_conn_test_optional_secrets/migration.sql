-- Secrets for an OPTIONAL capability on a connection test (e.g. spanning-portal, the console sign-in
-- behind Spanning's force-sync), brokered BEST-EFFORT by the runner.
--
-- Kept apart from secretNames because failing to resolve one of THOSE fails the whole test — which must
-- not happen for a capability the client may not even use: a broken Spanning console login would
-- otherwise report Spanning licensing as down, and (with the setup gate in enforce mode) withhold its
-- jobs. Additive + defaulted, so existing rows and older app instances are unaffected.
ALTER TABLE "ConnectionTest" ADD COLUMN IF NOT EXISTS "optionalSecretNames" TEXT[] NOT NULL DEFAULT '{}';
