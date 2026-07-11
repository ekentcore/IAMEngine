// Per-client run-readiness, COMPUTED from live state (no stored flag to go stale): for each enabled
// API system that needs a credential, is its secret WIRED (a usable Delinea reference) and has its
// connection test PASSED? Rolls up to one tier the UI badges:
//   ready       — every credentialed system is wired AND tested ok ("completely should work")
//   partial     — some are wired/ok but others are missing, untested, or failing ("core works, gaps")
//   not_set_up  — nothing is wired yet
//   no_systems  — the client has no credentialed API systems modeled (nothing to be ready for)
// Manual/browser systems (no secret) don't gate creds readiness; on-prem AD is included like any other.
import { NOT_NEEDED } from "../cases/case-secrets";

export type ReadinessTier = "ready" | "partial" | "not_set_up" | "no_systems";
// "not_needed" = every required secret is the NOT_NEEDED sentinel — a manual-step system with nothing
// to connect to. It's satisfied (complete via manual steps), NOT a failed/untested connection test.
export type ConnTestState = "ok" | "fail" | "untested" | "not_needed";

// Rolled-up state of a system's rights probe (from ConnectionTest.rights): verified = every op
// passed; missing = at least one op the credential definitely lacks; unverified = some ops the
// probe can't check automatically; unknown = no rights data (older runner / no rights-aware probe).
export type RightsState = "verified" | "missing" | "unverified" | "unknown";

// One step of the per-system setup checklist. "attested" = an operator recorded that they verified
// it manually (only the rights step uses this); "not_needed" = the system is a manual step.
export type SetupStepState = "done" | "attested" | "pending" | "failed" | "unknown" | "not_needed";
export type SystemSetupVector = {
  started: SetupStepState;   // operator opened the setup instructions (or later steps imply it)
  wired: SetupStepState;     // every required secret has a usable reference
  preflight: SetupStepState; // app-side field-shape check (ConnectionTest.fieldsOk)
  test: SetupStepState;      // live conn-test (resolve + connect + read)
  rights: SetupStepState;    // per-operation rights probe, or operator attestation
  complete: boolean;         // ready AND nothing definitely failed in preflight/rights
};

export type SystemReadiness = {
  systemKey: string;
  required: string[];        // secret names this system needs
  missingSecrets: string[];  // required secrets with no usable reference
  wired: boolean;            // all required secrets resolved (or marked not-needed)
  notNeeded: boolean;        // ALL required secrets are NOT_NEEDED — a manual step, no live test to run
  test: ConnTestState;       // latest connection-test outcome for this system
  ready: boolean;            // wired AND (tested ok OR not-needed)
  setup: SystemSetupVector;  // the five-step checklist derivation (chips on the client page)
};

export type ClientReadiness = {
  tier: ReadinessTier;
  label: string;             // short badge text
  summary: string;           // one-line explanation
  systemsTotal: number;      // credentialed API systems considered
  systemsReady: number;      // wired AND tested ok
  systemsWired: number;      // wired (regardless of test)
  systems: SystemReadiness[];
};

// A secret reference is "set" when it has a non-placeholder external id; NOT_NEEDED (manual step) counts
// as satisfied. Mirrors the broker/preflight semantics so readiness agrees with what actually runs.
function isSet(externalId: string | null | undefined): boolean {
  const v = (externalId ?? "").trim();
  if (!v || v === "REPLACE_ME") return false;
  return true; // includes the NOT_NEEDED sentinel — intentionally "satisfied"
}
function satisfied(name: string, byName: Map<string, string | null>): boolean {
  const v = byName.get(name);
  return v === NOT_NEEDED || isSet(v);
}

export type ReadinessInput = {
  // Enabled API systems that need a credential (mode=api, runs in at least one lane, secretNames>0).
  systems: { systemKey: string; secretNames: string[] }[];
  secretExternalIds: Map<string, string | null>; // client secret NAME -> externalId
  testBySystem: Map<string, ConnTestState>;       // latest conn-test outcome per systemKey
  // Optional richer inputs (absent = "unknown" everywhere — older callers keep working unchanged):
  setupBySystem?: Map<string, { startedAt: Date | null; attestedAt: Date | null }>; // operator state
  preflightBySystem?: Map<string, boolean | null>;                                   // ConnectionTest.fieldsOk
  rightsBySystem?: Map<string, RightsState>;                                         // rolled-up rights probe
};

// Derive the five-step chip vector for one system. Everything derivable is derived from live state
// (no stored stage to drift); only "started" and the rights attestation come from operator input.
function deriveSetupVector(opts: {
  wired: boolean;
  notNeeded: boolean;
  test: ConnTestState;
  setup?: { startedAt: Date | null; attestedAt: Date | null };
  preflight?: boolean | null;
  rights?: RightsState;
}): SystemSetupVector {
  const { wired, notNeeded, test } = opts;
  const anyEvidence = wired || test === "ok" || test === "fail"; // later steps imply "started"
  const started: SetupStepState = opts.setup?.startedAt || anyEvidence ? "done" : "pending";
  const wiredStep: SetupStepState = wired ? "done" : "pending";
  const preflight: SetupStepState = notNeeded
    ? "not_needed"
    : opts.preflight === true ? "done" : opts.preflight === false ? "failed" : "unknown";
  const testStep: SetupStepState =
    test === "not_needed" ? "not_needed" : test === "ok" ? "done" : test === "fail" ? "failed" : "pending";
  const attested = Boolean(opts.setup?.attestedAt);
  const rightsState: RightsState = notNeeded ? "unknown" : (opts.rights ?? "unknown");
  const rights: SetupStepState = notNeeded
    ? "not_needed"
    : rightsState === "verified" ? "done"
    : rightsState === "missing" ? "failed"
    : attested ? "attested" : "unknown";
  const ready = wired && (test === "ok" || test === "not_needed");
  return { started, wired: wiredStep, preflight, test: testStep, rights, complete: ready && preflight !== "failed" && rights !== "failed" };
}

export function computeClientReadiness(input: ReadinessInput): ClientReadiness {
  const systems: SystemReadiness[] = input.systems.map((s) => {
    const missingSecrets = s.secretNames.filter((n) => !satisfied(n, input.secretExternalIds));
    const wired = missingSecrets.length === 0;
    // A system whose EVERY required secret is marked NOT_NEEDED is a manual step — there's no live
    // connection to test, so it reads as "not needed" and is ready once wired (never "failed").
    const notNeeded = s.secretNames.length > 0 && s.secretNames.every((n) => input.secretExternalIds.get(n) === NOT_NEEDED);
    const test: ConnTestState = notNeeded ? "not_needed" : (input.testBySystem.get(s.systemKey) ?? "untested");
    const setup = deriveSetupVector({
      wired,
      notNeeded,
      test,
      setup: input.setupBySystem?.get(s.systemKey),
      preflight: input.preflightBySystem?.get(s.systemKey),
      rights: input.rightsBySystem?.get(s.systemKey),
    });
    return { systemKey: s.systemKey, required: s.secretNames, missingSecrets, wired, notNeeded, test, ready: wired && (test === "ok" || test === "not_needed"), setup };
  });

  const systemsTotal = systems.length;
  const systemsWired = systems.filter((s) => s.wired).length;
  const systemsReady = systems.filter((s) => s.ready).length;

  if (systemsTotal === 0) {
    return { tier: "no_systems", label: "no systems", summary: "No credentialed systems modeled for this client.", systemsTotal, systemsReady, systemsWired, systems };
  }
  if (systemsWired === 0) {
    return { tier: "not_set_up", label: "not set up", summary: `No credentials wired (0 of ${systemsTotal} systems).`, systemsTotal, systemsReady, systemsWired, systems };
  }
  if (systemsReady === systemsTotal) {
    const manual = systems.filter((s) => s.notNeeded).length;
    const summary = manual ? `All ${systemsTotal} systems ready (${manual} via manual steps).` : `All ${systemsTotal} systems wired and tested.`;
    return { tier: "ready", label: "ready", summary, systemsTotal, systemsReady, systemsWired, systems };
  }
  // Partial: spell out what's holding it back so the badge tooltip is actionable.
  const missing = systems.filter((s) => !s.wired).length;
  const untested = systems.filter((s) => s.wired && s.test === "untested").length;
  const failing = systems.filter((s) => s.wired && s.test === "fail").length;
  const rightsMissing = systems.filter((s) => s.setup.rights === "failed").length;
  const parts = [
    `${systemsReady} of ${systemsTotal} ready`,
    missing ? `${missing} missing creds` : "",
    untested ? `${untested} untested` : "",
    failing ? `${failing} failing` : "",
    rightsMissing ? `${rightsMissing} missing rights` : "",
  ].filter(Boolean);
  return { tier: "partial", label: "partial", summary: parts.join(" · "), systemsTotal, systemsReady, systemsWired, systems };
}
