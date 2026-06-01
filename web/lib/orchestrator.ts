// Plans a CaseRequest into ordered Jobs. The brain's core logic.
// See docs/DATA_MODEL.md ("Planning a case").
import type { ClientSystem, Action, Mode } from "@prisma/client";

export type PlannedJob = {
  systemKey: string;
  sequence: number;
  mode: Mode;
  requiresApproval: boolean;
  captureEvidence: boolean;
  secretNames: string[];
  config: unknown;
};

// Decide whether a system participates in this action, given the case payload.
function included(cs: ClientSystem, action: Action, payload: Record<string, unknown>): boolean {
  const when = action === "onboard" ? cs.onboardWhen : cs.offboardWhen;
  if (when === "never") return false;
  if (when === "always") return true;
  // on_request: turned on by a case-payload signal. Map per system as rules grow;
  // default: look for a truthy hint keyed by the system or its config.requestKey.
  const key = (cs.config as { requestKey?: string } | null)?.requestKey ?? cs.systemKey;
  return Boolean(payload[key]);
}

// Lane-specific deps (config.dependsOn[action]) override the system-level dependsOn.
// Filtered to deps that are actually present among `active`.
export function depsOf(s: ClientSystem, action: Action, present: Set<string>): string[] {
  const laneDeps = (s.config as { dependsOn?: Record<string, string[]> } | null)?.dependsOn?.[action];
  return (laneDeps ?? s.dependsOn).filter((d) => present.has(d));
}

// Topological sort honoring dependsOn (declared order as tiebreak). Shared by the
// orchestrator (planning jobs) and the runbook view (display order from the data).
export function topoOrder(active: ClientSystem[], action: Action): ClientSystem[] {
  const byKey = new Map(active.map((s) => [s.systemKey, s]));
  const present = new Set(byKey.keys());

  const order: ClientSystem[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (s: ClientSystem) => {
    if (state.get(s.systemKey) === "done") return;
    if (state.get(s.systemKey) === "open") throw new Error(`dependency cycle at ${s.systemKey}`);
    state.set(s.systemKey, "open");
    for (const d of depsOf(s, action, present)) visit(byKey.get(d)!);
    state.set(s.systemKey, "done");
    order.push(s);
  };
  for (const s of active) visit(s);
  return order;
}

export function planCase(
  systems: ClientSystem[],
  action: Action,
  payload: Record<string, unknown>
): PlannedJob[] {
  const active = systems.filter((s) => included(s, action, payload));
  return topoOrder(active, action).map((s, i) => ({
    systemKey: s.systemKey,
    sequence: i,
    mode: s.mode,
    requiresApproval: s.requiresApproval,
    captureEvidence: s.captureEvidence,
    secretNames: s.secretNames,
    config: s.config,
  }));
}
