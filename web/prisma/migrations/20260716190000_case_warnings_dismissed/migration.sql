-- FR #13: dismiss warnings on a completed case ("I finished the remaining steps manually").
ALTER TABLE "CaseRequest" ADD COLUMN "warningsDismissedAt" TIMESTAMP(3);
ALTER TABLE "CaseRequest" ADD COLUMN "warningsDismissedBy" TEXT;
