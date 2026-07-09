-- CaseRequest: timestamp of the auto-verify sweep completion (runs once before case-resolution).
ALTER TABLE "CaseRequest" ADD COLUMN "verifiedAt" TIMESTAMP(3);
