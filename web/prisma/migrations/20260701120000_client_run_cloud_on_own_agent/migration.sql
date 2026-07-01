-- Per-client flag: run cloud jobs on the client's own agent (when it has one) instead of the central runner.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "runCloudOnOwnAgent" BOOLEAN NOT NULL DEFAULT false;
