-- Attribute runner discovery RESULTS to the user who requested them (not the agent). Persist the
-- requesting user id at request time so the async result audit can stamp userId. Additive, nullable.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "adDiscoverRequestedById" TEXT;
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "cloudGroupsRequestedById" TEXT;
