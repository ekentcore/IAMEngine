// Import a case from a ServiceNow User Management ticket: fetch -> normalize -> map to a
// client in our roster -> plan. Idempotent on the SN case number.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { fetchUserManagementCase } from "../servicenow/intake";
import { normalizeIntake } from "../servicenow/intake-mapper";
import { fetchOnboardingIncident, isOnboardingIncident } from "../servicenow/incident-intake";
import { normalizeIncidentIntake } from "../servicenow/incident-mapper";
import { makeCaseRepository } from "./repository";
import { createAndPlanCase, type PlanOutcome } from "./planning-service";
import { makeEmailDomainResolver } from "./plan-domain";

export type ImportResult =
  | { ok: true; outcome: PlanOutcome; caseNumber: string; alreadyImported?: boolean }
  | { ok: false; error: string; code: "not_found" | "no_client" | "duplicate" | "no_number" };

export async function importCaseFromServiceNow(
  db: PrismaClient,
  number: string,
  actor: string,
  opts?: { emailDomainOverride?: string }
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

  const resolver = makeEmailDomainResolver(db);
  const outcome = await createAndPlanCase(
    repo,
    {
      clientSlug: slug,
      action: intake.action,
      serviceNowCaseNumber: intake.caseNumber,
      subject: intake.subject,
      payload: intake.payload,
    },
    actor,
    { resolveDomain: (client) => resolver(client, opts?.emailDomainOverride).then((r) => r.domain) }
  );

  return { ok: true, outcome, caseNumber: intake.caseNumber };
}

// Import an internal Coretelligent onboarding INCIDENT (record-producer variables) and plan it.
// Same idempotent-by-number + client-match + plan path as the UM importer, different intake source.
export async function importIncidentCase(
  db: PrismaClient,
  number: string,
  actor: string,
  opts?: { emailDomainOverride?: string }
): Promise<ImportResult> {
  const repo = makeCaseRepository(db);
  const trimmed = number.trim();
  if (!trimmed) return { ok: false, error: "incident number is required", code: "no_number" };

  const existing = await repo.findCaseIdByNumber(trimmed);
  if (existing) {
    return { ok: true, alreadyImported: true, caseNumber: trimmed, outcome: { caseId: existing, status: "queued", jobCount: 0, manualCount: 0, approvalCount: 0 } };
  }

  const raw = await fetchOnboardingIncident(snConfigFromEnv(), trimmed);
  if (!raw) return { ok: false, error: `no ServiceNow incident found for ${trimmed}`, code: "not_found" };
  if (!isOnboardingIncident(raw)) {
    return { ok: false, error: `${trimmed} isn't an onboarding incident (subcategory "User / On-Boarding")`, code: "not_found" };
  }

  const intake = normalizeIncidentIntake(raw);
  // Internal incidents carry the core_company sys_id + display name. Coretelligent (the MSP) has no
  // CSM customer_account sys_id, so match by company NAME first, then fall back to the sys_id.
  const companyName = String((raw["company"] as { display_value?: string })?.display_value ?? "").trim();
  let slug: string | null = null;
  if (companyName) {
    const c = await db.client.findFirst({ where: { name: { equals: companyName, mode: "insensitive" } }, select: { slug: true } });
    slug = c?.slug ?? null;
  }
  if (!slug && intake.clientSysId) slug = await repo.clientSysIdToSlug(intake.clientSysId);
  if (!slug) return { ok: false, code: "no_client", error: `the incident's company "${companyName}" isn't in the roster` };

  const resolver = makeEmailDomainResolver(db);
  const outcome = await createAndPlanCase(
    repo,
    { clientSlug: slug, action: intake.action, serviceNowCaseNumber: intake.caseNumber, subject: intake.subject, payload: intake.payload },
    actor,
    { resolveDomain: (client) => resolver(client, opts?.emailDomainOverride).then((r) => r.domain) }
  );
  return { ok: true, outcome, caseNumber: intake.caseNumber };
}

// Route by number prefix: INCxxxxxxx -> internal incident; everything else (UM/CS) -> UM case.
export function importByNumber(db: PrismaClient, number: string, actor: string, opts?: { emailDomainOverride?: string }): Promise<ImportResult> {
  return /^inc/i.test(number.trim())
    ? importIncidentCase(db, number, actor, opts)
    : importCaseFromServiceNow(db, number, actor, opts);
}
