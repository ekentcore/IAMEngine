-- Auto-update convergence guard: stop telling an agent to self-update forever when the pull never
-- takes. A self-update exits the runner process, so an agent that cannot converge was being killed
-- every 90 seconds until its supervisor gave up.
ALTER TABLE "Agent" ADD COLUMN "updateAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Agent" ADD COLUMN "updateStalledAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "updateStalledBuild" TEXT;
