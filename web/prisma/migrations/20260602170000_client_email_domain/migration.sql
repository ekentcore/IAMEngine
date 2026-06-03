-- Email/UPN domain derived from the client's ServiceNow contacts (vs the website-derived
-- primaryDomain). emailDomainLocked marks a human-curated value sync must not overwrite.
ALTER TABLE "Client" ADD COLUMN "emailDomain" TEXT;
ALTER TABLE "Client" ADD COLUMN "emailDomainLocked" BOOLEAN NOT NULL DEFAULT false;
