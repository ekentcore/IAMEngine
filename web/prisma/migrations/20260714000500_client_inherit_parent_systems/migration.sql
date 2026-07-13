-- Per-client switch for parent-systems inheritance (SN account hierarchy). Default true keeps
-- today's behavior: a system-less child plans from its parent. False breaks the link for a child
-- that doesn't match its parent.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "inheritParentSystems" BOOLEAN NOT NULL DEFAULT true;
