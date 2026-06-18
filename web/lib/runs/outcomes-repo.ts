// Queries over the append-only RunOutcome log — the cross-case record of what each module did on a
// run (success / warning / error + messages). Powers /runs, where module problems are tracked & fixed.
import type { PrismaClient, Prisma } from "@prisma/client";

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
};

export type OutcomeFilter = {
  verdict?: string;      // exact verdict; default (when includeClean is false) = warning + failed
  system?: string;       // a single module/system key
  q?: string;            // matches case number / client / error / system
  includeClean?: boolean; // include verified / skipped / manual rows too
  limit?: number;
};

export async function listOutcomes(db: PrismaClient, f: OutcomeFilter): Promise<OutcomeRow[]> {
  const where: Prisma.RunOutcomeWhereInput = {};
  if (f.system) where.systemKey = f.system;
  if (f.verdict) where.verdict = f.verdict;
  else if (!f.includeClean) where.verdict = { in: ["warning", "failed"] };
  const q = f.q?.trim();
  if (q) {
    where.OR = [
      { caseNumber: { contains: q, mode: "insensitive" } },
      { clientName: { contains: q, mode: "insensitive" } },
      { error: { contains: q, mode: "insensitive" } },
      { systemKey: { contains: q, mode: "insensitive" } },
    ];
  }
  return db.runOutcome.findMany({ where, orderBy: { at: "desc" }, take: f.limit ?? 250 });
}

// The modules with open problems, most-affected first — the "what to fix" leaderboard. Counts
// warning + failed outcomes per system. validateOnly read-backs count too (a failed verify is a
// real gap). Returns [] when everything's clean.
export async function moduleIssueSummary(db: PrismaClient): Promise<{ systemKey: string; failed: number; warnings: number }[]> {
  const rows = await db.runOutcome.groupBy({
    by: ["systemKey", "verdict"],
    where: { verdict: { in: ["warning", "failed"] } },
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
export async function outcomeSystems(db: PrismaClient): Promise<string[]> {
  const rows = await db.runOutcome.findMany({ distinct: ["systemKey"], select: { systemKey: true }, orderBy: { systemKey: "asc" } });
  return rows.map((r) => r.systemKey);
}
