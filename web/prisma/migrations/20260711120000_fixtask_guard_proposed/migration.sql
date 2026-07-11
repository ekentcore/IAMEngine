-- The one-unfinished-task-per-fingerprint guard must also cover 'proposed': a proposal awaiting
-- review must not be able to spawn a second analyze that races it to a second draft PR (the gate
-- belongs server-side, not just the UI's disabled button). Partial unique = raw SQL, as before.
DROP INDEX "FixTask_active_fingerprint_key";
CREATE UNIQUE INDEX "FixTask_active_fingerprint_key" ON "FixTask"("fingerprint") WHERE "status" IN ('queued', 'running', 'proposed', 'applying');
