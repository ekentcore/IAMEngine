-- CreateIndex
CREATE INDEX "CaseRequest_scheduledFor_idx" ON "CaseRequest"("scheduledFor");

-- One unfinished fix task per fingerprint, enforced atomically (Prisma can't express a partial
-- unique index, so it's raw SQL). Concurrent createFixTask callers that both pass the findFirst
-- guard collide here; the loser gets P2002, which the app maps to a 409.
CREATE UNIQUE INDEX "FixTask_active_fingerprint_key" ON "FixTask"("fingerprint") WHERE "status" IN ('queued', 'running');
