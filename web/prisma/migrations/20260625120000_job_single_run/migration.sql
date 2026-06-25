-- "Run this step only": a job claimable in isolation even while its case is paused.
ALTER TABLE "Job" ADD COLUMN "singleRun" BOOLEAN NOT NULL DEFAULT false;
