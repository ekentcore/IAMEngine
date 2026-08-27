-- Roles/personas inheritance for child clients, separate from systems inheritance (FR #0000041).
-- Additive and defaulted true, which is exactly today's behaviour for every child that inherits.
ALTER TABLE "Client" ADD COLUMN "inheritParentModeling" BOOLEAN NOT NULL DEFAULT true;
