-- Shared mailboxes discovered from Exchange Online, backing the per-client default shared-mailbox
-- access picker (FR #15). Shape: { mailboxes: [{ address, displayName }], discoveredAt }.
ALTER TABLE "Client" ADD COLUMN "cloudMailboxes" JSONB;
