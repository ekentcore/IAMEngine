// Core: IR -> v2 profile (+ a review-meta sidecar). Pure functions, no IO.
import type { Detected, IR, Backbone } from "./ir.js";
import type { DraftMeta, Lane, Profile, SecretRef, SystemEntry } from "./profile.js";

// system key -> conventional Delinea secret slot (name + human label).
const SYSTEM_SECRETS: Record<string, { name: string; label: string }> = {
  m365: { name: "m365-admin", label: "365 Admin Center" },
  entra: { name: "m365-admin", label: "365 Admin Center" },
  exchange: { name: "m365-admin", label: "365 Admin Center" },
  "active-directory": { name: "ad-dc", label: "Domain controller" },
  "directory-sync": { name: "ad-dc", label: "Domain controller" },
  mimecast: { name: "mimecast", label: "Mimecast Admin Console" },
  proofpoint: { name: "proofpoint", label: "Proofpoint Console" },
  spanning: { name: "spanning", label: "Spanning (uses 365 secret)" },
  teams: { name: "teams-admin", label: "Teams Admin Portal" },
  perimeter81: { name: "perimeter81", label: "Perimeter 81" },
  adobe: { name: "adobe", label: "Adobe Admin Console" },
  "google-workspace": { name: "google-admin", label: "Google Admin Console" },
  zoom: { name: "zoom", label: "Zoom Admin" },
  slack: { name: "slack", label: "Slack Admin" },
  egnyte: { name: "egnyte", label: "Egnyte Admin" },
  dropbox: { name: "dropbox", label: "Dropbox Admin" },
  knowbe4: { name: "knowbe4", label: "KnowBe4 Admin" },
  "1password": { name: "1password", label: "1Password Admin" },
};

function depFor(key: string, present: Set<string>): string[] {
  if (key === "servicenow") return [];
  if (key === "active-directory") return ["servicenow"];
  if (key === "directory-sync") return ["active-directory"];
  if (key === "m365") {
    if (present.has("directory-sync")) return ["directory-sync"];
    if (present.has("active-directory")) return ["active-directory"];
    return ["servicenow"];
  }
  if (key === "entra" || key === "exchange") return ["m365"];
  return present.has("m365") ? ["m365"] : ["servicenow"];
}

const VALID_WHEN = new Set(["always", "on-request", "never"]);
const VALID_GUARDRAILS = new Set(["do-not-delete", "do-not-move-ou", "no-device-wipe-without-approval"]);

// Map IR signals (free-form) into a profile lane, defending against values that would
// violate the closed-enum parts of the schema (when / guardrails).
function laneFromSignals(signals: Record<string, unknown> | undefined): Lane | undefined {
  if (!signals) return { when: "always" };
  const lane: Lane = {};
  const config: Record<string, unknown> = {};
  const w = String(signals.when ?? "");
  lane.when = (VALID_WHEN.has(w) ? w : "always") as Lane["when"];
  if (signals.captureEvidence) lane.captureEvidence = true;
  if (signals.requiresApproval) lane.requiresApproval = true;
  if (Array.isArray(signals.guardrails)) {
    const g = (signals.guardrails as unknown[]).filter((x): x is string => typeof x === "string" && VALID_GUARDRAILS.has(x));
    if (g.length) lane.guardrails = g;
  }
  if (signals.schedule) lane.schedule = signals.schedule as Lane["schedule"];
  if (Array.isArray(signals.licenses) && signals.licenses.length) config.licenses = signals.licenses;
  if (signals.ou) config.ou = signals.ou;
  if (Array.isArray(signals.groups) && signals.groups.length) config.groups = signals.groups;
  if (Object.keys(config).length) lane.config = config;
  return lane;
}

function band(score: number): DraftMeta["band"] {
  return score >= 0.8 ? "high" : score >= 0.6 ? "medium" : "low";
}

export interface Assembled { profile: Profile; meta: DraftMeta }

export function assembleProfile(ir: IR): Assembled {
  const slug = (ir.client.suggestedId || ir.client.leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 40);
  // never let the id be empty (non-Latin / punctuation-only leaf) — schema requires >=1 char
  const id = slug || `client-${String(ir.kb.onboard || ir.kb.offboard || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const backboneDefaulted = !ir.backboneHint;
  const backbone: Backbone = ir.backboneHint ?? "entra";
  const primaryDomainMissing = !ir.client.primaryDomain;

  // group detections by system key, splitting onboarding/offboarding
  const present = new Set(ir.detected.map((d) => d.systemKey));
  const byKey = new Map<string, { onboard?: Detected; offboard?: Detected }>();
  for (const d of ir.detected) {
    const slot = byKey.get(d.systemKey) ?? {};
    if (d.action === "onboarding") slot.onboard = d;
    else slot.offboard = d;
    byKey.set(d.systemKey, slot);
  }

  const systems: SystemEntry[] = [];
  const secretNames = new Set<string>();
  for (const [key, slot] of byKey) {
    const mode = (slot.onboard ?? slot.offboard)!.mode ?? "api";
    const entry: SystemEntry = { key, mode };
    const sec = SYSTEM_SECRETS[key];
    if (sec) {
      entry.secrets = [sec.name];
      secretNames.add(sec.name);
    }
    // only depend on systems that actually exist in this profile (never self/dangling)
    const deps = depFor(key, present).filter((d) => d !== key && present.has(d));
    if (deps.length) entry.dependsOn = deps;
    if (slot.onboard) entry.onboard = laneFromSignals(slot.onboard.signals);
    if (slot.offboard) entry.offboard = laneFromSignals(slot.offboard.signals);
    systems.push(entry);
  }
  if (secretNames.size === 0) secretNames.add("m365-admin");

  const secrets: Record<string, SecretRef> = {};
  for (const name of secretNames) {
    const label = Object.values(SYSTEM_SECRETS).find((s) => s.name === name)?.label ?? name;
    secrets[name] = { provider: "delinea", id: "REPLACE_ME", label };
  }

  // Prefer the username pattern + password rules parsed from the M365 onboarding steps;
  // fall back to a sane default only when the runbook didn't state them.
  const m365onb = ir.detected.find((d) => d.systemKey === "m365" && d.action === "onboarding");
  const msig = (m365onb?.signals ?? {}) as { usernamePattern?: string; password?: Record<string, unknown> };
  const identity: Profile["identity"] = {
    backbone,
    usernamePatterns: typeof msig.usernamePattern === "string" ? [msig.usernamePattern] : ["{first}{last}@{domain}"],
    password: { mode: "generate", ...(msig.password ?? {}), onOffboard: "reset" },
  };
  if (backbone === "ad-synced") identity.directorySync = { command: "Start-ADSyncSyncCycle -PolicyType Delta" };

  const profile: Profile = {
    schemaVersion: "2.0",
    client: { id, name: ir.client.leaf, primaryDomain: ir.client.primaryDomain ?? "REPLACE_ME.com" },
    identity,
    secrets,
    delivery: { method: present.has("mimecast") ? "mimecast-secure-email" : "manual", welcomeLetter: present.has("welcome-letter") },
    systems,
  };

  // confidence: avg detection confidence, penalised for the things a human must fix.
  const confs = ir.detected.map((d) => d.confidence);
  const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5;
  let score = avg;
  if (backboneDefaulted) score -= 0.15;
  if (primaryDomainMissing) score -= 0.1;
  const unmodeled = [...new Set(ir.unmodeled.map((u) => u.guess || u.section))];
  score -= 0.05 * Math.min(unmodeled.length, 4);
  score = Math.max(0, Math.min(1, Number(score.toFixed(2))));

  const meta: DraftMeta = {
    id,
    name: ir.client.leaf,
    confidence: score,
    band: band(score),
    backbone,
    backboneDefaulted,
    primaryDomainMissing,
    systemCount: systems.length,
    unmodeledCount: unmodeled.length,
    unmodeled,
    family: ir.client.family ?? null,
    kb: ir.kb,
    warnings: ir.warnings ?? [],
  };

  return { profile, meta };
}
