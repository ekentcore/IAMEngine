-- Record WHO opened a case and HOW, on the case itself.
--
-- Until now the creator existed only as a side effect: the `case.plan` AuditLog row that happens to
-- be written in the same breath as the case. That inference breaks the moment a case is created
-- without being planned, and it can't be filtered or sorted on. These columns make it a fact.

CREATE TYPE "CaseSource" AS ENUM ('manual', 'servicenow', 'intake_poll', 'sim', 'api');

ALTER TABLE "CaseRequest" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "CaseRequest" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "CaseRequest" ADD COLUMN "createdSource" "CaseSource" NOT NULL DEFAULT 'manual';

ALTER TABLE "CaseRequest"
    ADD CONSTRAINT "CaseRequest_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CaseRequest_createdByUserId_idx" ON "CaseRequest"("createdByUserId");
CREATE INDEX "CaseRequest_createdSource_createdAt_idx" ON "CaseRequest"("createdSource", "createdAt");

-- Backfill from history. Every existing case has a `case.plan` audit row written within the same
-- second as its creation, so the earliest one names the creator. Take the OLDEST (a case can be
-- re-planned later by someone else — that engineer didn't create it).
WITH first_plan AS (
    SELECT DISTINCT ON (a."caseRequestId")
           a."caseRequestId" AS case_id,
           a."actor"         AS actor,
           a."userId"        AS user_id
    FROM "AuditLog" a
    WHERE a."action" = 'case.plan' AND a."caseRequestId" IS NOT NULL
    ORDER BY a."caseRequestId", a."at" ASC
)
UPDATE "CaseRequest" c
SET "createdBy" = f.actor,
    -- Historic rows almost never set AuditLog.userId, but the actor label carries the email — and in
    -- more than one shape ("user:jane@core.tech", but also "ui:import-now:jane@core.tech"). Pull the
    -- email out of the label wherever it sits, so the FK is usable for both.
    "createdByUserId" = COALESCE(
        f.user_id,
        (SELECT u."id" FROM "User" u
          WHERE lower(u."email") = lower(substring(f.actor from '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]+')))
    ),
    "createdSource" = CASE
        WHEN f.actor LIKE 'system:intake-poll%' THEN 'intake_poll'::"CaseSource"
        WHEN f.actor LIKE 'cli:%'               THEN 'sim'::"CaseSource"
        WHEN f.actor LIKE 'system:%'            THEN 'api'::"CaseSource"
        -- A human-triggered case that carries no ServiceNow ticket was hand-keyed in the New case
        -- dialog; one that does carry a ticket was imported from ServiceNow.
        WHEN c."serviceNowCaseNumber" IS NULL   THEN 'manual'::"CaseSource"
        ELSE 'servicenow'::"CaseSource"
    END
FROM first_plan f
WHERE c."id" = f.case_id;

-- A case with no case.plan row at all (none exist today, but the column must not lie): mark it
-- unknown-provenance rather than silently claiming a human made it.
UPDATE "CaseRequest"
SET "createdSource" = 'api'::"CaseSource"
WHERE "createdBy" IS NULL;
