-- Give every feature request a sequential ticket number (#0000001, #0000002, …).
-- Existing rows are numbered oldest-first so the numbers agree with the order they were filed;
-- only then does the column get handed to a sequence, started past the highest backfilled value.
ALTER TABLE "FeatureRequest" ADD COLUMN "number" INTEGER;

UPDATE "FeatureRequest" f
SET "number" = o.rn
FROM (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
    FROM "FeatureRequest"
) o
WHERE f."id" = o."id";

CREATE SEQUENCE "FeatureRequest_number_seq" OWNED BY "FeatureRequest"."number";
SELECT setval(
    '"FeatureRequest_number_seq"',
    COALESCE((SELECT MAX("number") FROM "FeatureRequest"), 0) + 1,
    false
);
ALTER TABLE "FeatureRequest" ALTER COLUMN "number" SET DEFAULT nextval('"FeatureRequest_number_seq"');
ALTER TABLE "FeatureRequest" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "FeatureRequest_number_key" ON "FeatureRequest"("number");

-- hideAt: the moment the request leaves the board for the collapsed Completed table (null = on the
-- board). Hidden is derived (hideAt <= now), so the 7-day auto-hide needs no scheduled sweep.
ALTER TABLE "FeatureRequest" ADD COLUMN "hideAt" TIMESTAMP(3);
