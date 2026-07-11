-- Agent.priority: failover rank among peer runners of the same scope. LOWER = higher priority. Default
-- 100 so all existing agents are equal (load-balance, unchanged) until an operator sets priorities.
ALTER TABLE "Agent" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;
