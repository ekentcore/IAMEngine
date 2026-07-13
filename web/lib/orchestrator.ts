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

// Identity-flow invariant for on-prem-origin clients: when the identity ORIGINATES in on-prem AD, the
// order is ALWAYS create-in-AD -> directory-sync (push to the cloud) -> cloud consumers (entra / m365 /
// exchange, which need the synced user to exist). We enforce it at plan time so a mis-wired client can't
// deadlock — e.g. exchange waiting for a mailbox while the directory-sync that would create it is gated
// behind exchange. No-op for cloud-native clients (no active-directory system) — their ordering differs.
const IDENTITY_PIPELINE = ["active-directory", "directory-sync", "entra", "m365", "exchange"];

// For an on-prem-origin client, the corrected dependencies for the pipeline systems: each keeps its
// NON-pipeline deps (e.g. servicenow) but its pipeline-to-pipeline edges (forward OR reversed) are
// replaced by the single chain edge to the previous ACTIVE pipeline system. Returns null (leave deps
// untouched) when the client is cloud-native.
function identityPipelineDeps(active: ClientSystem[], declaredOf: (s: ClientSystem) => string[]): Map<string, string[]> | null {
  const activeKeys = new Set(active.map((s) => s.systemKey));
  if (!activeKeys.has("active-directory")) return null;
  const pipeActive = IDENTITY_PIPELINE.filter((k) => activeKeys.has(k));
  const pipeSet = new Set(pipeActive);
  const byKey = new Map(active.map((s) => [s.systemKey, s]));
  const out = new Map<string, string[]>();
  for (let i = 0; i < pipeActive.length; i++) {
    const key = pipeActive[i];
    const prev = i > 0 ? pipeActive[i - 1] : null;
    const nonPipeline = declaredOf(byKey.get(key)!).filter((d) => !pipeSet.has(d));
    out.set(key, prev ? [...new Set([...nonPipeline, prev])] : nonPipeline);
  }
  return out;
}

// Decide whether a system participates in this action, given the case payload.
function included(cs: ClientSystem, action: Action, payload: Record<string, unknown>, personaSystems?: ReadonlySet<string>): boolean {
  const when = action === "onboard" ? cs.onboardWhen : cs.offboardWhen;
  if (when === "never") return false;
  if (when === "always") return true;
  // by_persona: only when the selected persona's bundle lists this system (no persona -> excluded,
  // same shape as an unsignalled on_request). The key set comes from the caller via
  // personaSystemKeys() so persona selection stays centralized in buildPlanContext.
  if (when === "by_persona") return personaSystems?.has(cs.systemKey) ?? false;
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
  payload: Record<string, unknown>,
  // System keys the selected persona pulls in — gates by_persona lanes only (see personaSystemKeys).
  personaSystems?: ReadonlySet<string>,
  // Secret names the client marked "not needed" (the NOT_NEEDED sentinel). A system whose every
  // required secret is marked so is done by hand — planned as a manual step, not an api job.
  notNeededSecrets?: ReadonlySet<string>
): PlannedJob[] {
  const active = systems.filter((s) => included(s, action, payload, personaSystems));
  // Synthetic ONBOARD step: once the cloud mailbox exists, write the assigned email back into AD's
  // `mail` attribute. Applies to every AD-origin client (identity starts on-prem) automatically — no
  // per-client ClientSystem row or migration. It depends on the cloud consumers present (m365/exchange)
  // so it runs after them; the actual address is resolved + injected at dispatch time (runner-service
  // claim), since it isn't known until those run. Routed on-prem via ALWAYS_ON_PREM_SYSTEMS.
  const activeKeys = new Set(active.map((s) => s.systemKey));
  if (action === "onboard" && activeKeys.has("active-directory") && (activeKeys.has("m365") || activeKeys.has("exchange")) && !activeKeys.has("ad-email-writeback")) {
    const base = active.find((s) => s.systemKey === "active-directory")!;
    active.push({
      ...base,
      id: `${base.clientId}:ad-email-writeback`,
      systemKey: "ad-email-writeback",
      mode: "api",
      onboardWhen: "always",
      offboardWhen: "never",
      dependsOn: ["m365", "exchange"].filter((k) => activeKeys.has(k)),
      requiresApproval: false,
      captureEvidence: false,
      secretNames: ["ad-dc"],
      config: null,
    } as ClientSystem);
  }
  // Synthetic ONBOARD step: hybrid identity-link CHECK. For every AD + cloud client, after the cloud
  // account resolves, verify the on-prem object's source anchor (mS-DS-ConsistencyGuid / objectGUID)
  // matches the Entra immutableId — so a rehire / pre-existing cloud account LINKS instead of spawning
  // a duplicate. Detect + flag only (no auto-write). Runs on the client agent; the app injects the
  // Entra object's id/immutableId/sync state (from the m365 result) at dispatch time.
  if (action === "onboard" && activeKeys.has("active-directory") && (activeKeys.has("m365") || activeKeys.has("entra")) && !activeKeys.has("ad-consistency-check")) {
    const base = active.find((s) => s.systemKey === "active-directory")!;
    active.push({
      ...base,
      id: `${base.clientId}:ad-consistency-check`,
      systemKey: "ad-consistency-check",
      mode: "api",
      onboardWhen: "always",
      offboardWhen: "never",
      dependsOn: ["m365", "entra", "ad-email-writeback"], // filtered to present systems by declaredOf below
      requiresApproval: false,
      captureEvidence: false,
      secretNames: ["ad-dc"],
      config: null,
    } as ClientSystem);
  }
  const byKey = new Map(active.map((s) => [s.systemKey, s]));
  // Closing steps must run AFTER everything else, whatever the declared deps say — under DAG
  // gating an under-declared dependsOn would otherwise let case-resolution dispatch first.
  // runLast systems implicitly depend on every other (non-runLast) active system; among multiple
  // runLast systems the declared deps/order decide.
  const runLast = (s: ClientSystem) =>
    s.systemKey === "case-resolution" || Boolean((s.config as SystemConfig | null)?.runLast);
  const declaredOf = (s: ClientSystem): string[] => {
    const laneDeps = (s.config as SystemConfig | null)?.dependsOn?.[action];
    return (laneDeps ?? s.dependsOn).filter((d) => byKey.has(d));
  };
  // Enforce the on-prem identity flow (AD -> directory-sync -> cloud) for pipeline systems; other
  // systems keep their declared deps. This can't be reversed by bad data, so it's deadlock-proof.
  const pipelineDeps = identityPipelineDeps(active, declaredOf);
  const depsOf = (s: ClientSystem): string[] => {
    const declared = pipelineDeps?.get(s.systemKey) ?? declaredOf(s);
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
    // "Not needed" secrets = the system has no credential to broker because a human does this step
    // (the same rule readiness.ts calls notNeeded). Plan it as a MANUAL checklist item: left as an
    // api job it would dispatch, fail at the credential broker (409 "marked not needed"), and take
    // the case down with it. A real credential appearing later flips it straight back to api.
    const noCredNeeded =
      s.mode === "api" && s.secretNames.length > 0 && s.secretNames.every((n) => notNeededSecrets?.has(n) ?? false);
    const mode: Mode = noCredNeeded ? "manual" : s.mode;
    return {
      systemKey: s.systemKey,
      sequence: i,
      mode,
      dependsOn: depsOf(s),
      intent,
      // Approval gates only auto-executing API steps. A manual/browser step is done by a human, so
      // the act of doing it IS the approval — it must never put the case in "needs approval".
      // A DESTRUCTIVE step ALWAYS requires approval (and evidence below) — it can't be turned off.
      requiresApproval: mode === "api" ? (destructive || (ra ? Boolean(ra[action]) : s.requiresApproval)) : false,
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
