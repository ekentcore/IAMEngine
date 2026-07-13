// Import a case from a ServiceNow User Management ticket: fetch -> normalize -> map to a
// client in our roster -> plan. Idempotent on the SN case number.
import type { PrismaClient } from "@prisma/client";
import { snConfigFromEnv } from "../servicenow/gateway";
import { fetchUserManagementCase } from "../servicenow/intake";
import { normalizeIntake, umIntakeAction, umSubcategoryLabel, type NormalizedIntake } from "../servicenow/intake-mapper";
import { fetchOnboardingIncident, incidentAction } from "../servicenow/incident-intake";
import { normalizeIncidentIntake } from "../servicenow/incident-mapper";
import { makeCaseRepository } from "./repository";
import { createAndPlanCase, type PlanOutcome } from "./planning-service";
import { makeEmailDomainResolver } from "./plan-domain";

export type ImportResult =
  | { ok: true; outcome: PlanOutcome; caseNumber: string; alreadyImported?: boolean }
  | { ok: false; error: string; code: "not_found" | "no_client" | "duplicate" | "no_number" | "engine_opt_out" };

// "Do not use engine": the client's SN cases are never imported (the intake sweep counts these as
// skipped, a manual import surfaces the reason). Checked after client matching so an unknown
// client still reads no_client; cases already imported are untouched (the idempotence check runs
// before this and re-imports/restores them as usual).
async function engineOptedOut(db: PrismaClient, slug: string): Promise<boolean> {
  const c = await db.client.findUnique({ where: { slug }, select: { engineOptOut: true } });
  return c?.engineOptOut ?? false;
}

export async function importCaseFromServiceNow(
  db: PrismaClient,
  number: string,
  actor: string,
  opts?: { emailDomainOverride?: string; dryRun?: boolean }
): Promise<ImportResult> {
  const repo = makeCaseRepository(db);

  const trimmed = number.trim();
  if (!trimmed) return { ok: false, error: "case number is required", code: "no_number" };

  // Idempotent: don't re-import the same ticket.
  const existing = await repo.findCaseIdByNumber(trimmed);
  if (existing) {
    // If the ticket was trashed, re-importing brings it back rather than colliding on the unique
    // SN number (no-op if it wasn't trashed).
    await repo.restoreCase(existing);
    return {
      ok: true,
      alreadyImported: true,
      caseNumber: trimmed,
      outcome: { caseId: existing, status: "queued", jobCount: 0, manualCount: 0, approvalCount: 0 },
    };
  }

  const raw = await fetchUserManagementCase(snConfigFromEnv(), trimmed);
  if (!raw) return { ok: false, error: `no ServiceNow case found for ${trimmed}`, code: "not_found" };

  // Skip non-lifecycle tickets (e.g. Computer Build / 30300) — the app only handles on/off-boarding.
  if (!umIntakeAction(raw)) {
    return { ok: false, code: "not_found", error: `${trimmed} is a "${umSubcategoryLabel(raw) || "non on/off-boarding"}" request, not an on/off-boarding case — not imported` };
  }

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

  if (await engineOptedOut(db, slug)) {
    return { ok: false, code: "engine_opt_out", error: `${trimmed}'s client is marked "do not use engine" — its cases aren't imported` };
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
      dryRun: opts?.dryRun ?? false,
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
  opts?: { emailDomainOverride?: string; dryRun?: boolean }
): Promise<ImportResult> {
  const repo = makeCaseRepository(db);
  const trimmed = number.trim();
  if (!trimmed) return { ok: false, error: "incident number is required", code: "no_number" };

  const existing = await repo.findCaseIdByNumber(trimmed);
  if (existing) {
    // If the ticket was trashed, re-importing brings it back rather than colliding on the unique
    // SN number (no-op if it wasn't trashed).
    await repo.restoreCase(existing);
    return { ok: true, alreadyImported: true, caseNumber: trimmed, outcome: { caseId: existing, status: "queued", jobCount: 0, manualCount: 0, approvalCount: 0 } };
  }

  const raw = await fetchOnboardingIncident(snConfigFromEnv(), trimmed);
  if (!raw) return { ok: false, error: `no ServiceNow incident found for ${trimmed}`, code: "not_found" };
  if (!incidentAction(raw)) {
    return { ok: false, error: `${trimmed} isn't a user on/off-boarding incident (subcategory "User / On-Boarding" or "User / Off-Boarding")`, code: "not_found" };
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

  if (await engineOptedOut(db, slug)) {
    return { ok: false, code: "engine_opt_out", error: `${companyName || slug} is marked "do not use engine" — its cases aren't imported` };
  }

  const resolver = makeEmailDomainResolver(db);
  const outcome = await createAndPlanCase(
    repo,
    { clientSlug: slug, action: intake.action, serviceNowCaseNumber: intake.caseNumber, subject: intake.subject, payload: intake.payload, dryRun: opts?.dryRun ?? false },
    actor,
    { resolveDomain: (client) => resolver(client, opts?.emailDomainOverride).then((r) => r.domain) }
  );
  return { ok: true, outcome, caseNumber: intake.caseNumber };
}

// Re-fetch + normalize the latest intake for an existing case's SN number, routing by prefix
// (INC -> internal incident, else UM). Returns null if the record is gone / no longer a lifecycle
// incident. Used to REFRESH an already-imported case's fields (Rescan) and by the re-plan path —
// the single place that knows both intake sources, so neither has to special-case INC vs UM.
export async function fetchNormalizedIntake(number: string): Promise<NormalizedIntake | null> {
  const trimmed = number.trim();
  if (!trimmed) return null;
  const config = snConfigFromEnv();
  if (/^inc/i.test(trimmed)) {
    const raw = await fetchOnboardingIncident(config, trimmed);
    if (!raw || !incidentAction(raw)) return null;
    return normalizeIncidentIntake(raw);
  }
  const raw = await fetchUserManagementCase(config, trimmed);
  if (!raw || !umIntakeAction(raw)) return null; // gone, or a non-lifecycle ticket (e.g. Computer Build)
  return normalizeIntake(raw);
}

// Route by number prefix: INCxxxxxxx -> internal incident; everything else (UM/CS) -> UM case.
export function importByNumber(db: PrismaClient, number: string, actor: string, opts?: { emailDomainOverride?: string; dryRun?: boolean }): Promise<ImportResult> {
  return /^inc/i.test(number.trim())
    ? importIncidentCase(db, number, actor, opts)
    : importCaseFromServiceNow(db, number, actor, opts);
}
