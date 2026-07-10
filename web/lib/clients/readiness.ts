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

export type SystemReadiness = {
  systemKey: string;
  required: string[];        // secret names this system needs
  missingSecrets: string[];  // required secrets with no usable reference
  wired: boolean;            // all required secrets resolved (or marked not-needed)
  notNeeded: boolean;        // ALL required secrets are NOT_NEEDED — a manual step, no live test to run
  test: ConnTestState;       // latest connection-test outcome for this system
  ready: boolean;            // wired AND (tested ok OR not-needed)
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
};

export function computeClientReadiness(input: ReadinessInput): ClientReadiness {
  const systems: SystemReadiness[] = input.systems.map((s) => {
    const missingSecrets = s.secretNames.filter((n) => !satisfied(n, input.secretExternalIds));
    const wired = missingSecrets.length === 0;
    // A system whose EVERY required secret is marked NOT_NEEDED is a manual step — there's no live
    // connection to test, so it reads as "not needed" and is ready once wired (never "failed").
    const notNeeded = s.secretNames.length > 0 && s.secretNames.every((n) => input.secretExternalIds.get(n) === NOT_NEEDED);
    const test: ConnTestState = notNeeded ? "not_needed" : (input.testBySystem.get(s.systemKey) ?? "untested");
    return { systemKey: s.systemKey, required: s.secretNames, missingSecrets, wired, notNeeded, test, ready: wired && (test === "ok" || test === "not_needed") };
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
  const parts = [
    `${systemsReady} of ${systemsTotal} ready`,
    missing ? `${missing} missing creds` : "",
    untested ? `${untested} untested` : "",
    failing ? `${failing} failing` : "",
  ].filter(Boolean);
  return { tier: "partial", label: "partial", summary: parts.join(" · "), systemsTotal, systemsReady, systemsWired, systems };
}
