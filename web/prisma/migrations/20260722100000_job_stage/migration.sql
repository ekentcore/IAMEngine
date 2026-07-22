-- Coarse setup-stage for a browser-based credential-setup run (signin|create|harvest|vault). A SCALAR
-- sibling to Job.progress (the free-text narration trail) so the guided-setup run checklist can read
-- one field to advance live, without conflating stage markers with the human-facing narration.
-- Additive + nullable — no backfill needed (older/other jobs simply have no stage).
ALTER TABLE "Job" ADD COLUMN "stage" TEXT;
