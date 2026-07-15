// Queries over the append-only RunOutcome log — the cross-case record of what each module did on a
// run (success / warning / error + messages). Powers /runs, where module problems are tracked & fixed.
import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { type ClientScope, clientIdWhere } from "../auth/client-scope";

// Stable fingerprint for "the same line for the same case". The SAME (case, module, verdict, messages,
// error) across re-runs hashes identically, so marking one "Fixed" can resolve every occurrence and the
// list can collapse duplicates. NOT time/id-dependent. Shared by the writer (recordResult) and the UI.
export function outcomeFingerprint(p: { caseRequestId: string; systemKey: string; verdict: string; messages: string[]; error: string | null }): string {
  const parts = [p.caseRequestId, p.systemKey, p.verdict, (p.messages ?? []).join(""), p.error ?? ""];
  return createHash("sha1").update(parts.join("")).digest("hex");
}

export type OutcomeRow = {
  id: string;
  at: Date;
  caseRequestId: string;
  caseNumber: string;
  action: string;
  clientName: string;
  systemKey: string;
  verdict: string;
  status: string;
  messages: string[];
  error: string | null;
  validateOnly: boolean;
  // Structured credential-failure detail (see lib/jobs/cred-failure.ts) when the run's problem was a
  // credential — lets /runs and remediation scripts key off the code instead of the error text.
  credFailure: unknown | null;
  fingerprint: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
};

export type OutcomeFilter = {
  verdict?: string;      // exact verdict; default (when includeClean is false) = warning + failed
  system?: string;       // a single module/system key
  q?: string;            // matches case number / client / error / system
  includeClean?: boolean; // include verified / skipped / manual rows too
  includeResolved?: boolean; // include lines already marked "Fixed" (hidden by default)
  onlyResolved?: boolean; // ONLY lines marked "Fixed" — the always-on feed for the v2 "Fixed lines"
                          // section, so a just-fixed line shows there regardless of the "fixed" filter
  scope?: ClientScope;   // per-operator client visibility (null = unrestricted) — see lib/auth/client-scope
  limit?: number;
};

// Build the Prisma `where` for the outcome log. Kept as a pure function so the load-bearing
// resolved/clean filter logic is unit-testable without a DB. The resolved handling is the crux of
// the Fixed-table feature: by default resolved lines are hidden; onlyResolved returns exactly them.
export function buildOutcomeWhere(f: OutcomeFilter): Prisma.RunOutcomeWhereInput {
  const where: Prisma.RunOutcomeWhereInput = {};
  where.clientId = clientIdWhere(f.scope ?? null);
  if (f.system) where.systemKey = f.system;
  if (f.verdict) where.verdict = f.verdict;
  else if (!f.includeClean) where.verdict = { in: ["warning", "failed"] };
  if (f.onlyResolved) where.resolvedAt = { not: null };
  else if (!f.includeResolved) where.resolvedAt = null;
  const q = f.q?.trim();
  if (q) {
    where.OR = [
      { caseNumber: { contains: q, mode: "insensitive" } },
      { clientName: { contains: q, mode: "insensitive" } },
      { error: { contains: q, mode: "insensitive" } },
      { systemKey: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export async function listOutcomes(db: PrismaClient, f: OutcomeFilter): Promise<OutcomeRow[]> {
  return db.runOutcome.findMany({ where: buildOutcomeWhere(f), orderBy: { at: "desc" }, take: f.limit ?? 500 });
}

// Collapse the rows into one entry per fingerprint (the same line for the same case), newest first,
// with how many times it recurred — so the log isn't a wall of identical warnings.
export type OutcomeGroup = OutcomeRow & { count: number };
export function groupOutcomes(rows: OutcomeRow[]): OutcomeGroup[] {
  const byFp = new Map<string, OutcomeGroup>();
  for (const r of rows) {
    const key = r.fingerprint || r.id; // legacy rows (no fingerprint) never collapse
    const g = byFp.get(key);
    if (g) g.count++;
    else byFp.set(key, { ...r, count: 1 }); // rows are newest-first, so the kept row is the latest
  }
  return [...byFp.values()];
}

// The modules with open problems, most-affected first — the "what to fix" leaderboard. Counts
// warning + failed outcomes per system. validateOnly read-backs count too (a failed verify is a
// real gap). Returns [] when everything's clean.
export async function moduleIssueSummary(db: PrismaClient, scope: ClientScope = null): Promise<{ systemKey: string; failed: number; warnings: number }[]> {
  const rows = await db.runOutcome.groupBy({
    by: ["systemKey", "verdict"],
    where: { verdict: { in: ["warning", "failed"] }, resolvedAt: null, clientId: clientIdWhere(scope) }, // resolved lines don't count
    _count: { _all: true },
  });
  const bySys = new Map<string, { systemKey: string; failed: number; warnings: number }>();
  for (const r of rows) {
    const e = bySys.get(r.systemKey) ?? { systemKey: r.systemKey, failed: 0, warnings: 0 };
    if (r.verdict === "failed") e.failed += r._count._all;
    else e.warnings += r._count._all;
    bySys.set(r.systemKey, e);
  }
  return [...bySys.values()].sort((a, b) => b.failed - a.failed || b.warnings - a.warnings);
}

// Distinct system keys seen in the log — for the filter dropdown.
export async function outcomeSystems(db: PrismaClient, scope: ClientScope = null): Promise<string[]> {
  const rows = await db.runOutcome.findMany({ where: { clientId: clientIdWhere(scope) }, distinct: ["systemKey"], select: { systemKey: true }, orderBy: { systemKey: "asc" } });
  return rows.map((r) => r.systemKey);
}
