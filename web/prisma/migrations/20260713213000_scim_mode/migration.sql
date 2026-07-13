-- New system mode: scim — the IdP provisions the app automatically. Planned as a visible step,
-- created already-satisfied so the case keeps moving.
ALTER TYPE "Mode" ADD VALUE IF NOT EXISTS 'scim';
