-- Structured credential-failure capture: the broker stamps WHY a credential could not be
-- brokered on the Job; recordResult copies it onto the RunOutcome row so /runs (and scripts)
-- can act on the code instead of parsing free-text errors. Additive + nullable.
ALTER TABLE "Job" ADD COLUMN "credFailure" JSONB;
ALTER TABLE "RunOutcome" ADD COLUMN "credFailure" JSONB;
