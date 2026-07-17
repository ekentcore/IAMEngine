-- Low-code connectors: declarative http/browser definitions the generic executor interprets
-- (docs/CONNECTOR_BUILDER.md). Additive + idempotent: one new table, nothing else touched.
CREATE TABLE IF NOT EXISTS "Connector" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "kind"        TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'draft',
    "definition"  JSONB NOT NULL,
    "secretNames" TEXT[],
    "notes"       TEXT,
    "createdBy"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Connector_key_key" ON "Connector"("key");
