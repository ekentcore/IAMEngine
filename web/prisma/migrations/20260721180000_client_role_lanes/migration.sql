-- Add the client-lifecycle roles (FR / RBAC): client_onboarding can add + modify + set up clients
-- (systems + credential references) but NOT run cases or archive; client_offboarding is the same plus
-- archiving clients. Archive is restricted to client_offboarding + global/super via the new
-- client.archive permission (see web/lib/auth/permissions.ts). Adding enum values only — no data change.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'client_onboarding';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'client_offboarding';
