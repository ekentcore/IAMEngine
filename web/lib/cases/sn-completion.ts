// Planning half of "the ServiceNow ticket is resolved — mark the whole case completed": decide
// which steps still need flipping to succeeded, or refuse when a runner is mid-execution (same
// in-flight rule as trashCase — never yank state out from under a live job). Pure, so the route
// stays a thin transaction around this.
export type CompletionPlan = { ok: false; reason: "in_flight" } | { ok: true; flipIds: string[] };

export function planCompletion(jobs: { id: string; status: string }[]): CompletionPlan {
  if (jobs.some((j) => j.status === "dispatched" || j.status === "running")) {
    return { ok: false, reason: "in_flight" };
  }
  // succeeded/skipped are already terminal-done for deriveCaseStatus; everything else (pending,
  // manual, failed) gets marked succeeded with the manualCompletion flag so each step is
  // individually undoable via the existing per-step mark-complete toggle.
  const flipIds = jobs.filter((j) => j.status !== "succeeded" && j.status !== "skipped").map((j) => j.id);
  return { ok: true, flipIds };
}
