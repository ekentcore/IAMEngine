-- Manual (non-ServiceNow) cases get an auto-assigned IAM number: IAM0000001, IAM0000002, …
-- A dedicated sequence (not CaseRequest's PK / not a shared autoincrement) so the IAM run stays
-- contiguous — a ServiceNow-sourced case, which already carries its own UM… number, never consumes
-- one. The app formats nextval as "IAM" + 7-digit zero-pad (lib/cases/case-number.ts) and writes it
-- into the existing unique serviceNowCaseNumber column, so every case still has exactly one number.
CREATE SEQUENCE IF NOT EXISTS "CaseRequest_iam_seq" AS bigint START WITH 1 INCREMENT BY 1;
