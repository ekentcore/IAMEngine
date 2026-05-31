// Import a case from a ServiceNow User Management ticket: fetch -> normalize -> map to a
// client in our roster -> plan. Idempotent on the SN case number.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { fetchUserManagementCase } from "../servicenow/intake";
import { normalizeIntake } from "../servicenow/intake-mapper";
import { makeCaseRepository } from "./repository";
import { createAndPlanCase, type PlanOutcome } from "./planning-service";

export type ImportResult =
  | { ok: true; outcome: PlanOutcome; caseNumber: string; alreadyImported?: boolean }
  | { ok: false; error: string; code: "not_found" | "no_client" | "duplicate" | "no_number" };

export async function importCaseFromServiceNow(
  db: PrismaClient,
  number: string,
  actor: string
): Promise<ImportResult> {
  const repo = makeCaseRepository(db);

  const trimmed = number.trim();
  if (!trimmed) return { ok: false, error: "case number is required", code: "no_number" };

  // Idempotent: don't re-import the same ticket.
  const existing = await repo.findCaseIdByNumber(trimmed);
  if (existing) {
    return {
      ok: true,
      alreadyImported: true,
      caseNumber: trimmed,
      outcome: { caseId: existing, status: "queued", jobCount: 0, manualCount: 0, approvalCount: 0 },
    };
  }

  const raw = await fetchUserManagementCase(snConfigFromEnv(), trimmed);
  if (!raw) return { ok: false, error: `no ServiceNow case found for ${trimmed}`, code: "not_found" };

  const intake = normalizeIntake(raw);
  if (!intake.clientSysId) {
    return { ok: false, error: `case ${trimmed} has no account/company`, code: "no_client" };
  }

  const slug = await repo.clientSysIdToSlug(intake.clientSysId);
  if (!slug) {
    return {
      ok: false,
      code: "no_client",
      error: `the case's client isn't in the synced roster yet — run "Refresh from ServiceNow" first`,
    };
  }

  const outcome = await createAndPlanCase(
    repo,
    {
      clientSlug: slug,
      action: intake.action,
      serviceNowCaseNumber: intake.caseNumber,
      subject: intake.subject,
      payload: intake.payload,
    },
    actor
  );

  return { ok: true, outcome, caseNumber: intake.caseNumber };
}
