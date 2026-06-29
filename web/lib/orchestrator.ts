// Plans a CaseRequest into ordered Jobs. The brain's core logic.
// See docs/DATA_MODEL.md ("Planning a case").
import type { ClientSystem, Action, Mode } from "@prisma/client";

// A step's INTENT — chiefly for offboarding. "disable" = reversible containment (lock the account,
// isolate the device, revoke sessions); eventually safe to automate. "destructive" = actually deletes
// / unrecoverable (delete a mailbox, hard-delete the user); ALWAYS gated for human approval AND we
// snapshot state first (captureEvidence) so it's redoable/auditable. null = unclassified (the default
// for onboard, which isn't disable/destructive in this sense).
export type StepIntent = "disable" | "destructive";

export type PlannedJob = {
  systemKey: string;
  sequence: number;
  mode: Mode;
  requiresApproval: boolean;
  captureEvidence: boolean;
  intent: StepIntent | null;
  secretNames: string[];
  config: unknown;
  // Effective dependencies (lane-specific override applied, filtered to systems in this plan).
  // Persisted on the job so the claim gate runs the DAG, not strict sequence order.
  dependsOn: string[];
};

// The per-lane config shape seed.ts writes into ClientSystem.config.
type SystemConfig = {
  onboard?: unknown;
  offboard?: unknown;
  dependsOn?: Record<string, string[]>;
  runLast?: boolean;
  requestKey?: string;
  requiresApproval?: Record<string, boolean | undefined>;
  captureEvidence?: Record<string, boolean | undefined>;
  intent?: Record<string, StepIntent | undefined>;
};

// Maps an on-request system to the intake-payload signal that turns it on. This is the
// generalized mechanism (vs hardcoding per profile): add a row as new signals are mapped
// in the intake-mapper. A profile/editor can override via config.requestKey, and manual
// cases can set a payload flag named after the system key.
const REQUEST_SIGNALS: Record<string, (payload: Record<string, unknown>, action: Action) => boolean> = {
  teams: (p, a) => a === "onboard" && Boolean(p.officeLineRequired || p.cellPhoneRequired),
};

// Decide whether a system participates in this action, given the case payload.
function included(cs: ClientSystem, action: Action, payload: Record<string, unknown>): boolean {
  const when = action === "onboard" ? cs.onboardWhen : cs.offboardWhen;
  if (when === "never") return false;
  if (when === "always") return true;
  // on_request: explicit requestKey override -> central signal map -> systemKey fallback.
  const cfg = cs.config as SystemConfig | null;
  if (cfg?.requestKey) return Boolean(payload[cfg.requestKey]);
  const signal = REQUEST_SIGNALS[cs.systemKey];
  if (signal) return signal(payload, action);
  return Boolean(payload[cs.systemKey]);
}

// Topological sort honoring dependsOn (declared order as tiebreak). Lane-specific deps,
// if present in config.dependsOn[action], override the system-level dependsOn.
export function planCase(
  systems: ClientSystem[],
  action: Action,
  payload: Record<string, unknown>
): PlannedJob[] {
  const active = systems.filter((s) => included(s, action, payload));
  const byKey = new Map(active.map((s) => [s.systemKey, s]));
  // Closing steps must run AFTER everything else, whatever the declared deps say — under DAG
  // gating an under-declared dependsOn would otherwise let case-resolution dispatch first.
  // runLast systems implicitly depend on every other (non-runLast) active system; among multiple
  // runLast systems the declared deps/order decide.
  const runLast = (s: ClientSystem) =>
    s.systemKey === "case-resolution" || Boolean((s.config as SystemConfig | null)?.runLast);
  const depsOf = (s: ClientSystem): string[] => {
    const laneDeps = (s.config as SystemConfig | null)?.dependsOn?.[action];
    const declared = (laneDeps ?? s.dependsOn).filter((d) => byKey.has(d));
    if (!runLast(s)) return declared;
    const everyoneElse = active.filter((o) => o.systemKey !== s.systemKey && !runLast(o)).map((o) => o.systemKey);
    return [...new Set([...declared, ...everyoneElse])];
  };

  const order: ClientSystem[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (s: ClientSystem) => {
    if (state.get(s.systemKey) === "done") return;
    if (state.get(s.systemKey) === "open") throw new Error(`dependency cycle at ${s.systemKey}`);
    state.set(s.systemKey, "open");
    for (const d of depsOf(s)) visit(byKey.get(d)!);
    state.set(s.systemKey, "done");
    order.push(s);
  };
  for (const s of active) visit(s);

  return order.map((s, i) => {
    const cfg = s.config as SystemConfig | null;
    // Per-lane flags: if config carries the per-lane map use it authoritatively (an absent
    // lane means false — no cross-lane bleed); otherwise fall back to the collapsed column.
    const ra = cfg?.requiresApproval;
    const ce = cfg?.captureEvidence;
    // Effective intent for this lane. Offboard defaults to "disable" (most offboard work is
    // reversible containment) so every offboard step carries a classification; onboard is unclassified.
    const intent: StepIntent | null = cfg?.intent?.[action] ?? (action === "offboard" ? "disable" : null);
    const destructive = intent === "destructive";
    return {
      systemKey: s.systemKey,
      sequence: i,
      mode: s.mode,
      dependsOn: depsOf(s),
      intent,
      // Approval gates only auto-executing API steps. A manual/browser step is done by a human, so
      // the act of doing it IS the approval — it must never put the case in "needs approval".
      // A DESTRUCTIVE step ALWAYS requires approval (and evidence below) — it can't be turned off.
      requiresApproval: s.mode === "api" ? (destructive || (ra ? Boolean(ra[action]) : s.requiresApproval)) : false,
      // Destructive steps ALWAYS snapshot state first ("save the settings so we can redo it").
      captureEvidence: destructive || (ce ? Boolean(ce[action]) : s.captureEvidence),
      // SentinelOne's offboard resolves the user's machines from their Entra registered devices, so it
      // also needs the m365-admin app brokered (catalog-wide, no per-client wiring). If the client has
      // no m365-admin it simply isn't brokered and the runner falls back to config/payload machineName.
      secretNames: s.systemKey === "sentinelone" && !s.secretNames.includes("m365-admin")
        ? [...s.secretNames, "m365-admin"]
        : s.secretNames,
      // The runner needs only this action's resolved config, not the whole blob.
      config: cfg ? (cfg[action] ?? null) : null,
    };
  });
}
