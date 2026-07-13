-- Per-case email-domain override for multi-domain clients: the operator picks a non-default
-- domain before running; replan consults it as precedence tier 1. Additive + nullable.
ALTER TABLE "CaseRequest" ADD COLUMN "emailDomainOverride" TEXT;
