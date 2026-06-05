// Pre-flight PLAYBOOK: from a planned case, render a complete, ordered, dry-run picture of
// exactly what will happen — the real scripts (with resolved values), in dependency order, with
// the post-action checks each step validates. Nothing executes; this is the doc to review
// before running and to attach to the case.
//
// Pure core (buildPlaybook) takes already-loaded rows so it's unit-testable without a DB; the
// DB loader (loadPlaybook) gathers the inputs and a markdown renderer produces the export.
import type { PrismaClient } from "@prisma/client";
import { automationPreview, validationChecks, type Action } from "../automation";
import { stepRunsOn, serverHintFromLabel } from "./case-secrets";

export type PlaybookStep = {
  seq: number; // 1-based, in execution order
  systemKey: string;
  systemName: string;
  action: Action;
  mode: string; // api | browser | manual
  dependsOn: string[]; // system keys this step runs after (present in this case)
  runsOn: string; // where it executes — client-network agent (+ server) / central runner / app
  willRun: string | null; // the resolved script for an automated step
  validates: string[]; // the read-back checks the validator will run
  secretNames: string[];
  requiresApproval: boolean;
  manualText: string | null; // checklist text for a manual/browser step
};

export type Playbook = {
  caseId: string;
  caseNumber: string | null;
  subject: string | null;
  action: Action;
  client: { name: string; slug: string; primaryDomain: string };
  user: string | null; // resolved UPN / user being offboarded, for the header
  steps: PlaybookStep[];
};

// A planned job (raw, as stored by createCaseWithJobs).
type JobRow = { systemKey: string; sequence: number; mode: string; request: unknown };
type JobRequest = { config?: unknown; requiresApproval?: boolean; secretNames?: string[] };
// Enough of a ClientSystem to derive dependency order (mirrors orchestrator.depsOf).
type SystemRow = { systemKey: string; dependsOn: string[]; config: unknown };

export type BuildPlaybookInput = {
  caseId: string;
  caseNumber: string | null;
  subject: string | null;
  action: Action;
  client: { name: string; slug: string; primaryDomain: string; identity: unknown; backbone?: string | null };
  payload: Record<string, unknown>;
  jobs: JobRow[];
  systems: SystemRow[];
  names: Map<string, string>; // systemKey -> display name
  secretServers?: Map<string, string | null>; // secret name -> host hint (from the Delinea label)
  manualText?: Map<string, string>; // systemKey -> runbook step text (manual steps)
};

function userHeader(action: Action, payload: Record<string, unknown>): string | null {
  if (action === "offboard") {
    const u = payload.userToOffboard ?? payload.userPrincipalName ?? payload.workEmail;
    return u ? String(u) : null;
  }
  const u = payload.userPrincipalName ?? payload.workEmail ?? payload.displayName;
  return u ? String(u) : null;
}

export function buildPlaybook(input: BuildPlaybookInput): Playbook {
  const { action, client, payload, jobs, systems, names } = input;
  const present = new Set(jobs.map((j) => j.systemKey));
  const sysByKey = new Map(systems.map((s) => [s.systemKey, s]));

  const steps: PlaybookStep[] = [...jobs]
    .sort((a, b) => a.sequence - b.sequence)
    .map((j, i) => {
      const r = (j.request ?? {}) as JobRequest;
      const sys = sysByKey.get(j.systemKey);
      // lane-aware deps win over the system-level list (mirrors orchestrator.depsOf + clients page).
      const laneDeps = (sys?.config as { dependsOn?: Record<string, string[]> } | null)?.dependsOn?.[action];
      const dependsOn = (laneDeps ?? sys?.dependsOn ?? []).filter((d) => present.has(d));
      const isApi = j.mode === "api";
      const secretNames = r.secretNames ?? [];
      const servers = secretNames.map((n) => input.secretServers?.get(n) ?? null).filter((s): s is string => !!s);
      return {
        seq: i + 1,
        systemKey: j.systemKey,
        systemName: names.get(j.systemKey) ?? j.systemKey,
        action,
        mode: j.mode,
        dependsOn,
        runsOn: stepRunsOn(j.systemKey, client.backbone, servers),
        willRun: isApi ? automationPreview(j.systemKey, action, r.config ?? null, client.identity, client.primaryDomain, payload) : null,
        validates: isApi ? validationChecks(j.systemKey, action) : [],
        secretNames: r.secretNames ?? [],
        requiresApproval: Boolean(r.requiresApproval),
        manualText: isApi ? null : input.manualText?.get(j.systemKey) ?? null,
      };
    });

  return {
    caseId: input.caseId,
    caseNumber: input.caseNumber,
    subject: input.subject,
    action,
    client: { name: client.name, slug: client.slug, primaryDomain: client.primaryDomain },
    user: userHeader(action, payload),
    steps,
  };
}

// Render the playbook as a reviewable / attachable markdown document.
export function renderPlaybookMarkdown(pb: Playbook): string {
  const out: string[] = [];
  out.push(`# Playbook (dry run) — ${pb.subject ?? pb.caseNumber ?? pb.caseId}`);
  out.push("");
  out.push(`- Client: ${pb.client.name} (${pb.client.slug}) · ${pb.client.primaryDomain}`);
  out.push(`- Action: ${pb.action}`);
  if (pb.user) out.push(`- User: ${pb.user}`);
  if (pb.caseNumber) out.push(`- ServiceNow: ${pb.caseNumber}`);
  out.push(`- Steps: ${pb.steps.length}`);
  out.push("");
  out.push("> Dry run — nothing executes. This is what will run, in order, when the case is dispatched.");
  out.push("");
  for (const s of pb.steps) {
    out.push(`## ${s.seq}. ${s.systemName} (${s.systemKey}) — ${s.mode}${s.requiresApproval ? " · requires approval" : ""}`);
    out.push(`Runs on: ${s.runsOn}`);
    if (s.dependsOn.length) out.push(`After: ${s.dependsOn.join(", ")}`);
    if (s.secretNames.length) out.push(`Secrets: ${s.secretNames.join(", ")}`);
    out.push("");
    if (s.willRun) {
      out.push("```powershell");
      out.push(s.willRun);
      out.push("```");
    } else if (s.manualText) {
      out.push(`Manual / checklist: ${s.manualText}`);
    } else {
      out.push("_Manual / checklist step._");
    }
    if (s.validates.length) {
      out.push("");
      out.push("Validates after running:");
      for (const v of s.validates) out.push(`- ${v}`);
    }
    out.push("");
  }
  return out.join("\n");
}

// DB loader: gather the case + jobs + client + systems + catalog names + manual runbook text,
// then build the playbook. Returns null if the case doesn't exist.
export async function loadPlaybook(db: PrismaClient, caseId: string): Promise<Playbook | null> {
  const c = await db.caseRequest.findUnique({
    where: { id: caseId },
    include: {
      client: { select: { id: true, name: true, slug: true, primaryDomain: true, identity: true, backbone: true, systems: true, secrets: { select: { name: true, label: true } } } },
      jobs: { orderBy: { sequence: "asc" }, select: { systemKey: true, sequence: true, mode: true, request: true } },
    },
  });
  if (!c) return null;

  const keys = [...new Set(c.jobs.map((j) => j.systemKey))];
  const catalog = await db.systemCatalog.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } });
  const names = new Map(catalog.map((s) => [s.key, s.name]));
  // secret name -> host hint parsed from its Delinea label (drives "runs on" per step).
  const secretServers = new Map<string, string | null>(c.client.secrets.map((s) => [s.name, serverHintFromLabel(s.label)]));

  // Manual/browser step text: the matching runbook section's joined step lines, if present.
  const sections = await db.runbookSection.findMany({
    where: { clientId: c.client.id, action: c.action, systemKey: { in: keys } },
    select: { systemKey: true, steps: true, title: true },
  });
  const manualText = new Map<string, string>();
  for (const s of sections) {
    if (!s.systemKey) continue;
    const text = Array.isArray(s.steps) && s.steps.length ? (s.steps as string[]).join(" → ") : s.title;
    manualText.set(s.systemKey, text);
  }

  return buildPlaybook({
    caseId: c.id,
    caseNumber: c.serviceNowCaseNumber,
    subject: c.subject,
    action: c.action as Action,
    client: { name: c.client.name, slug: c.client.slug, primaryDomain: c.client.primaryDomain, identity: c.client.identity, backbone: c.client.backbone },
    payload: (c.payload ?? {}) as Record<string, unknown>,
    jobs: c.jobs.map((j) => ({ systemKey: j.systemKey, sequence: j.sequence, mode: j.mode, request: j.request })),
    systems: c.client.systems.map((s) => ({ systemKey: s.systemKey, dependsOn: s.dependsOn, config: s.config })),
    names,
    secretServers,
    manualText,
  });
}
