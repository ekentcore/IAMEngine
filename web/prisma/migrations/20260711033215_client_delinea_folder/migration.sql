-- Additive: nullable column for the per-client Delinea write-path folder id.
-- Read-only brokering is unaffected; NULL = fall back to DELINEA_FOLDER_MAP[slug] / disabled.
ALTER TABLE "Client" ADD COLUMN "delineaFolderId" TEXT;
