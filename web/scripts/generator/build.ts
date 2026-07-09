// Build a draft v2 profile object (validates against profiles/_schema.json) from a
// client's detected systems + inferred backbone. Secret ids are REPLACE_ME placeholders —
// the structure is generated; the Delinea refs are filled in by a human later.
import { CATALOG, inferBackbone, type Lane } from "../../lib/generator/system-map";
import type { ClientKb } from "./kb";

export type DraftProfile = {
  schemaVersion: "2.0" | "2.1";
  client: { id: string; name: string; primaryDomain: string; domains?: string[] };
  identity: Record<string, unknown>;
  secrets: Record<string, { provider: "delinea"; id: string; label?: string }>;
  systems: Array<Record<string, unknown>>;
};

export type BuildResult = {
  profile: DraftProfile;
  confidence: "high" | "medium" | "low";
  backboneConfident: boolean;
  systemKeys: string[];
};

function laneObject(when: Lane): Record<string, unknown> {
  return { when };
}

export function buildProfile(
  kb: ClientKb,
  matched: { slug: string; name: string; primaryDomain: string } | null
): BuildResult {
  // union of systems seen in either lane, in a stable catalog-aware order
  const detected = new Set<string>([...kb.onboardSystems, ...kb.offboardSystems]);
  const { backbone, confident: backboneConfident } = inferBackbone(detected);

  // order: catalog tier then detection order, but always lead with servicenow
  const ordered = [...detected].sort((a, b) => (CATALOG[a]?.tier ?? 9) - (CATALOG[b]?.tier ?? 9));

  const secrets: DraftProfile["secrets"] = {};
  const systems: Array<Record<string, unknown>> = [];

  for (const key of ordered) {
    const cat = CATALOG[key];
    if (!cat) continue; // unmodeled headers are reported separately, not emitted as systems
    const onboardSeen = kb.onboardSystems.includes(key);
    const offboardSeen = kb.offboardSystems.includes(key);

    const sys: Record<string, unknown> = { key, mode: cat.mode };
    if (cat.secret) {
      sys.secrets = [cat.secret];
      if (!secrets[cat.secret]) secrets[cat.secret] = { provider: "delinea", id: "REPLACE_ME", label: cat.secret };
    }
    if (cat.dependsOn?.length) sys.dependsOn = cat.dependsOn.filter((d) => detected.has(d));

    // Emit a lane only when the catalog supports it AND it appeared in that runbook
    // (or the system is an "always" core system that the runbook implies).
    if (cat.onboard && (onboardSeen || cat.onboard === "always")) sys.onboard = laneObject(cat.onboard);
    if (cat.offboard && (offboardSeen || cat.offboard === "always")) sys.offboard = laneObject(cat.offboard);

    // skip systems that ended up with neither lane
    if (sys.onboard || sys.offboard) systems.push(sys);
  }

  const identity: Record<string, unknown> = {
    backbone,
    usernamePatterns: ["{first}{last}@{domain}", "{firstInitial}{last}@{domain}"],
    password: { mode: "generate", minLength: 14, onOffboard: "reset" },
  };
  if (backbone === "ad-synced") {
    identity.directorySync = { command: "Start-ADSyncSyncCycle -PolicyType Delta" };
  }

  // Always ensure at least a placeholder secret so the schema's minProperties:1 holds.
  if (Object.keys(secrets).length === 0) {
    secrets["m365-admin"] = { provider: "delinea", id: "REPLACE_ME", label: "m365-admin" };
  }

  const slug = matched?.slug ?? slugify(kb.clientLeaf);
  const profile: DraftProfile = {
    schemaVersion: "2.0",
    client: {
      id: slug,
      name: matched?.name ?? kb.clientLeaf,
      primaryDomain: matched?.primaryDomain || normalizeDomain(kb.domainRaw) || `${slug}.example`,
    },
    identity,
    secrets,
    systems: systems.length ? systems : [{ key: "servicenow", mode: "api", onboard: { when: "always" } }],
  };

  // Confidence: high if matched to a roster client AND backbone confident AND >=3 systems.
  let confidence: BuildResult["confidence"] = "high";
  if (!matched || !backboneConfident) confidence = "medium";
  if (systems.length < 2 || !matched) confidence = "low";

  return { profile, confidence, backboneConfident, systemKeys: ordered.filter((k) => CATALOG[k]) };
}

export function slugify(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "client"
  );
}

export function normalizeDomain(website: string | null): string {
  if (!website) return "";
  const d = website.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].trim();
  // A real domain has a dot (a TLD). The KB's domain_raw is often a SN hierarchy path
  // ("TOP/Client"), which splits to a bare token like "top" — never a domain. Reject it so
  // it can't poison roster matching (every client collapsing to one bogus domain key).
  return d.includes(".") ? d : "";
}
