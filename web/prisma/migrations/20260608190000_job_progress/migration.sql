-- Job: live phase trail while running ([{ts, phase}]), shown in the run report.
ALTER TABLE "Job" ADD COLUMN "progress" JSONB;
