// "Steps on this case" (FR #173 / #134): which of the client's systems run on ONE case, and how an
// operator's choice becomes CaseRequest.requestedSystems / skippedSystems.
//
// A row per client system that has a step in this lane (lane != never). `natural` is what the plan
// would do with no per-case choice — the lane, the intake signals, the persona and any intake rule.
// The operator only ever edits the DIFFERENCE from natural: a conditional system switched on is
// "requested"; a naturally-planned system switched off is "skipped". So a system nobody touched keeps
// following the intake, and re-importing the ticket can still change it.
import type { Action } from "@prisma/client";

export type Lane = "always" | "on_request" | "by_persona";

export type StepRow = {
  systemKey: string;
  lane: Lane;
  natural: boolean; // planned without any per-case choice
  runs: boolean; // planned on this case now (natural + requested - skipped)
  // Why the checkbox can't change, or null when it can. A step that already ran can't be un-run (a
  // re-plan keeps it anyway); one an intake rule skips is decided by that rule, not per case.
  locked: string | null;
};

type SystemLanes = { systemKey: string; onboardWhen: string; offboardWhen: string };

const RAN = new Set(["dispatched", "running", "succeeded", "failed"]);

export function stepRows(opts: {
  systems: SystemLanes[];
  action: Action;
  natural: ReadonlySet<string>;
  requested: readonly string[];
  skipped: readonly string[];
  intakeSkipped: ReadonlySet<string>;
  jobs: { systemKey: string; status: string }[];
}): StepRow[] {
  const requested = new Set(opts.requested);
  const skipped = new Set(opts.skipped);
  const ran = new Set(opts.jobs.filter((j) => RAN.has(j.status)).map((j) => j.systemKey));
  const rows: StepRow[] = [];
  for (const s of opts.systems) {
    const when = opts.action === "onboard" ? s.onboardWhen : s.offboardWhen;
    if (when !== "always" && when !== "on_request" && when !== "by_persona") continue;
    const natural = opts.natural.has(s.systemKey);
    const runs = !skipped.has(s.systemKey) && !opts.intakeSkipped.has(s.systemKey) && (natural || requested.has(s.systemKey));
    const locked = ran.has(s.systemKey)
      ? "already ran on this case"
      : opts.intakeSkipped.has(s.systemKey)
        ? "skipped by an intake rule for this requester"
        : null;
    rows.push({ systemKey: s.systemKey, lane: when, natural, runs, locked });
  }
  return rows.sort((a, b) => a.systemKey.localeCompare(b.systemKey));
}

// The operator's desired set -> the two stored lists. Only differences from natural are stored, and
// only for systems that have a step in this lane (anything else is ignored, never persisted).
export function selectionToLists(rows: StepRow[], wantRunning: ReadonlySet<string>): { requestedSystems: string[]; skippedSystems: string[] } {
  const requestedSystems: string[] = [];
  const skippedSystems: string[] = [];
  for (const r of rows) {
    const want = wantRunning.has(r.systemKey);
    if (want && !r.natural) requestedSystems.push(r.systemKey);
    if (!want && r.natural) skippedSystems.push(r.systemKey);
  }
  return { requestedSystems, skippedSystems };
}
