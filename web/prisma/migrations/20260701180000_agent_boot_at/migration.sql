-- Runner process start time (reported on heartbeat) for the Agents uptime display.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "bootAt" TIMESTAMP(3);
