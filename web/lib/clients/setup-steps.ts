// The ordered plan behind the guided credential-setup wizard. Turns the client's secret wiring +
// run-readiness into ONE step per secretName the client needs, ordered core-systems-first, and
// enriched with everything the wizard renders (what the secret is for, the exact fields to collect,
// the vendor setup guide, whether it's already wired/tested). Pure — no DB, so it unit-tests and the
// page stays thin. It RE-SEQUENCES existing primitives; it computes no new credential state.
import { MODULES } from "@/lib/modules/catalog";
import { SECRET_FIELD_REQUIREMENTS, type FieldReq } from "@/lib/secrets/field-requirements";
import { secretHelp, type SecretHelp } from "@/lib/help/secret-help";
import { NOT_NEEDED } from "@/lib/cases/case-secrets";
import type { SecretRow } from "@/lib/secrets/wiring";
import type { ClientReadiness, ConnTestState, SystemReadiness } from "@/lib/clients/readiness";

// Volume-weighted importance: core identity is wired first, hardware/backlog last. Mirrors the
// Modules-page grouping so the wizard's order reads like the platform's own priority.
const GROUP_ORDER: string[] = [
  "Core / identity",
  "Email security",
  "Apps & access",
  "Security / endpoint",
  "Notifications",
  "Manual / hardware",
  "Backlog (no executor)",
];
const groupRank = (group: string | null | undefined): number => {
  const i = group ? GROUP_ORDER.indexOf(group) : -1;
  return i === -1 ? GROUP_ORDER.length : i;
};

export type SetupStep = {
  secretName: string;         // logical name the systems reference (e.g. "m365-admin")
  systemKeys: string[];       // systemKeys that broker this secret
  systemNames: string[];      // human names for those systems (from the module catalog)
  group: string | null;       // module group of the primary (highest-priority) system
  purpose: string;            // one-line "what this credential is for"
  externalId: string;         // current Delinea reference ("" if unset, or the NOT_NEEDED sentinel)
  label: string | null;       // operator label on the reference
  wired: boolean;             // has a usable reference (or marked not-needed)
  notNeeded: boolean;         // marked NOT_NEEDED — a manual step, nothing to connect to
  test: ConnTestState;        // aggregate live connection-test state across referencing systems
  ready: boolean;             // wired AND (not-needed OR every referencing system tested ok)
  // OPTIONAL: this credential unlocks one EXTRA capability (e.g. spanning-portal -> Spanning's
  // force-sync console sign-in) and nothing requires it. Offered so it CAN be wired, but a client that
  // never wires it is completely set up. Callers must not count an unwired optional step against
  // progress or completion — doing so tells every Spanning client they're a credential short forever.
  optional: boolean;
  fieldRequirements: FieldReq[]; // the exact fields to collect for this credential
  help: SecretHelp | null;    // deep link to the vendor setup guide, when one exists
};

// Does this step count toward "is the client set up?" — an unwired OPTIONAL credential does not.
// (Once wired, it does count: a broken credential you chose to add is worth surfacing.)
export const stepCounts = (s: SetupStep): boolean => !s.optional || s.wired;

// Roll several referencing systems' live test states into one for the credential: any failure wins,
// then any untested, else ok. Empty (no credentialed system references it) reads as untested.
function aggregateTest(states: ConnTestState[]): ConnTestState {
  if (states.length === 0) return "untested";
  if (states.some((s) => s === "fail")) return "fail";
  if (states.some((s) => s === "untested")) return "untested";
  if (states.every((s) => s === "not_needed")) return "not_needed";
  return "ok";
}

const nameForSystem = (systemKey: string): string => MODULES.find((m) => m.key === systemKey)?.name ?? systemKey;
const groupForSystem = (systemKey: string): string | null => MODULES.find((m) => m.key === systemKey)?.group ?? null;

// Build the full ordered step list for a client. `rows` are the secret wiring rows (one per needed
// secretName); `readiness.systems` supplies the per-system wired/test breakdown so a step's ready
// state agrees exactly with the detail-page Readiness table. Callers show all steps for progress and
// drive the wizard off the not-ready ones.
export function buildSetupSteps(rows: SecretRow[], readiness: ClientReadiness | null): SetupStep[] {
  const readinessSystems: SystemReadiness[] = readiness?.systems ?? [];

  const steps = rows.map((row): SetupStep => {
    const notNeeded = row.externalId === NOT_NEEDED;
    // The credentialed api systems that actually reference this secret — these carry live test state.
    const refSystems = readinessSystems.filter((s) => s.required.includes(row.name));
    // Prefer the readiness systemKeys (credentialed), falling back to the wiring's referencedBy so a
    // secret referenced only by manual systems still names what it's for.
    const systemKeys = refSystems.length > 0 ? refSystems.map((s) => s.systemKey) : row.referencedBy;
    const systemNames = systemKeys.map(nameForSystem);

    // "wired" for THIS credential: its own reference is set for every referencing system — NOT the
    // whole system's wired state (a system needing a second, still-missing secret shouldn't make this
    // credential's step read unwired).
    const wired = refSystems.length > 0 ? refSystems.every((s) => !s.missingSecrets.includes(row.name)) : row.isSet || notNeeded;
    const test: ConnTestState = notNeeded ? "not_needed" : aggregateTest(refSystems.map((s) => s.test));
    // Ready mirrors readiness: wired AND (manual step OR every referencing system tested ok). When no
    // credentialed system references it (nothing to live-test), a usable reference is enough.
    const ready = notNeeded ? wired : refSystems.length > 0 ? refSystems.every((s) => s.ready) : wired;

    const optional = row.optional === true;
    const primaryGroup = systemKeys.map(groupForSystem).sort((a, b) => groupRank(a) - groupRank(b))[0] ?? null;
    const usedBy = systemNames.length > 0 ? systemNames.join(", ") : "no modeled system";
    const purpose = optional
      ? `Optional — an extra capability for ${usedBy}. Everything else works without it.`
      : `Credential for ${usedBy}${primaryGroup ? ` (${primaryGroup})` : ""}.`;

    return {
      secretName: row.name,
      systemKeys,
      systemNames,
      group: primaryGroup,
      purpose,
      externalId: row.externalId,
      label: row.label,
      wired,
      notNeeded,
      test,
      ready,
      optional,
      fieldRequirements: SECRET_FIELD_REQUIREMENTS[row.name] ?? [],
      help: secretHelp(row.name, row.referencedBy),
    };
  });

  // Core systems first (by module group), then alphabetical by secret name for a stable order.
  return steps.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.secretName.localeCompare(b.secretName));
}
