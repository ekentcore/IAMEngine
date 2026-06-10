-- Operator pause: paused cases are excluded from job claiming until resumed.
ALTER TABLE "CaseRequest" ADD COLUMN "pausedAt" TIMESTAMP(3);
