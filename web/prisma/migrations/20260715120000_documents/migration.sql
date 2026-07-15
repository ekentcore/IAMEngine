-- The platform's own reference documents, versioned in-app.
--
-- Four documents ship as content (client overview, setup guide, security design, internal
-- reference). Each Document holds a chain of DocumentVersions (Markdown). The newest PUBLISHED
-- version is the live one; an "Update with AI" run reads the change log and produces a DRAFT that
-- an admin reviews before it publishes. Nothing here is a secret — these are our own docs — so the
-- content lives in the app database.

CREATE TYPE "DocAudience" AS ENUM ('client', 'internal');
CREATE TYPE "DocVersionStatus" AS ENUM ('draft', 'published');

CREATE TABLE "Document" (
    "id"        TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "title"     TEXT NOT NULL,
    "audience"  "DocAudience" NOT NULL DEFAULT 'client',
    "summary"   TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Document_slug_key" ON "Document"("slug");

CREATE TABLE "DocumentVersion" (
    "id"               TEXT NOT NULL,
    "documentId"       TEXT NOT NULL,
    "version"          TEXT NOT NULL,
    "status"           "DocVersionStatus" NOT NULL DEFAULT 'draft',
    "markdown"         TEXT NOT NULL,
    "changeNote"       TEXT,
    "generatedByAi"    BOOLEAN NOT NULL DEFAULT false,
    "changelogThrough" TEXT,
    "createdById"      TEXT,
    "createdByLabel"   TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt"      TIMESTAMP(3),
    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");
CREATE INDEX "DocumentVersion_documentId_status_idx" ON "DocumentVersion"("documentId", "status");

ALTER TABLE "DocumentVersion"
    ADD CONSTRAINT "DocumentVersion_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
