-- Client.parentId: ServiceNow account hierarchy (children inherit the parent's modeled systems
-- when they have none of their own).
ALTER TABLE "Client" ADD COLUMN "parentId" TEXT;
CREATE INDEX "Client_parentId_idx" ON "Client"("parentId");
ALTER TABLE "Client" ADD CONSTRAINT "Client_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProcurementWatch: a Procurement Case watched for a job blocked on license seats; resolved -> the
-- job re-queues automatically.
CREATE TABLE "ProcurementWatch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'watching',
    "note" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProcurementWatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcurementWatch_jobId_key" ON "ProcurementWatch"("jobId");
CREATE INDEX "ProcurementWatch_state_lastCheckedAt_idx" ON "ProcurementWatch"("state", "lastCheckedAt");
ALTER TABLE "ProcurementWatch" ADD CONSTRAINT "ProcurementWatch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
