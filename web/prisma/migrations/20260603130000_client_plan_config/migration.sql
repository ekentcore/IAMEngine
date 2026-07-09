-- v2.1 plan-time resolution inputs from the profile (personas, globals, locations).
ALTER TABLE "Client" ADD COLUMN "personas" JSONB;
ALTER TABLE "Client" ADD COLUMN "globals" JSONB;
ALTER TABLE "Client" ADD COLUMN "locations" JSONB;
