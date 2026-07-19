import type { ChangeDelta, ChangeDiff, RemovalMode } from "./change-types";
import { isProtectedGroup, DIRECTORY_SYSTEMS } from "./change-types";

export function emptyDiff(systemKey: string): ChangeDiff {
  return { systemKey, add: [], removeGroups: [], reconcileGroups: false, desiredGroups: [] };
}

const dedupeCI = (xs: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
};

const notIn = (xs: string[], others: string[]): string[] => {
  const set = new Set(others.map((o) => o.toLowerCase()));
  return xs.filter((x) => !set.has(x.toLowerCase()));
};

// MOVER: compute per-directory diffs from a target group set + the old role's managed groups.
export function computeMoverDiff(args: {
  directorySystems: string[];
  targetGroupsBySystem: Record<string, string[]>;
  fromManagedGroupsBySystem: Record<string, string[]>;
  targetOuBySystem?: Record<string, string>;
  removalMode: RemovalMode;
}): ChangeDiff[] {
  const { directorySystems, targetGroupsBySystem, fromManagedGroupsBySystem, targetOuBySystem, removalMode } = args;
  return directorySystems.map((systemKey) => {
    const d = emptyDiff(systemKey);
    const target = dedupeCI(targetGroupsBySystem[systemKey] ?? []);
    d.add = target;
    d.desiredGroups = target;
    if (removalMode === "full") {
      d.reconcileGroups = true; // runner removes anything live not in desiredGroups (minus protected)
    } else if (removalMode === "scoped") {
      // managed by the old role ON THIS SYSTEM but not granted by the new role, excluding
      // protected groups. Never fall back to a cross-system union — a system where the target
      // persona grants nothing (e.g. m365 for an AD-only persona) must not inherit removals
      // that actually belong to a different directory system.
      const managed = dedupeCI(fromManagedGroupsBySystem[systemKey] ?? []);
      d.removeGroups = notIn(managed, target).filter((g) => !isProtectedGroup(g));
    }
    const ou = targetOuBySystem?.[systemKey];
    if (systemKey === "active-directory" && ou) d.moveToOu = ou;
    return d;
  });
}

// AD-HOC: map hand-picked deltas onto per-directory diffs.
export function deltasToDiff(deltas: ChangeDelta[], directorySystems: string[]): ChangeDiff[] {
  const byKey = new Map<string, ChangeDiff>(directorySystems.map((k) => [k, emptyDiff(k)]));
  const dirTargets = (system?: string): ChangeDiff[] => {
    if (system) { const d = byKey.get(system); return d ? [d] : []; }
    return [...byKey.values()];
  };
  // group deltas fan to every directory system EXCEPT exchange: the Change lane's exchange leg
  // only understands DLs/365-groups (namedGroups) and shared mailboxes, never plain security
  // groups, so a group delta must never leak into exchange.add/removeGroups.
  const groupTargets = (system?: string): ChangeDiff[] => {
    if (system) {
      if (system === "exchange") return []; // exchange doesn't take security groups
      const d = byKey.get(system);
      return d ? [d] : [];
    }
    return [...byKey.values()].filter((d) => d.systemKey !== "exchange");
  };
  for (const delta of deltas) {
    const v = delta.value.trim();
    if (!v) continue;
    if ((delta.target === "group") && isProtectedGroup(v)) continue; // never touch privileged groups
    if (delta.target === "group") {
      for (const d of groupTargets(delta.system)) {
        if (delta.op === "add") d.add.push(v); else d.removeGroups.push(v);
      }
    } else if (delta.target === "dl") {
      const exo = byKey.get("exchange"); if (!exo) continue;
      if (delta.op === "add") (exo.namedGroups ??= []).push(v); else (exo.removeNamedGroups ??= []).push(v);
    } else if (delta.target === "sharedMailbox") {
      const exo = byKey.get("exchange"); if (!exo) continue;
      if (delta.op === "add") (exo.addSharedMailboxes ??= []).push(v); else (exo.removeSharedMailboxes ??= []).push(v);
    } else if (delta.target === "license") {
      const m = byKey.get("m365"); if (!m) continue;
      if (delta.op === "add") (m.licenses ??= []).push(v); else (m.removeLicenses ??= []).push(v);
    } else if (delta.target === "ou") {
      // remove-ou is intentionally a no-op: there's no "remove" semantics for an OU move.
      const ad = byKey.get("active-directory"); if (ad && delta.op === "add") ad.moveToOu = v;
    } else if (delta.target === "attribute") {
      const [key, ...rest] = v.split("=");
      if (!key || rest.length === 0) continue;
      for (const d of dirTargets(delta.system)) (d.attributes ??= {})[key.trim()] = rest.join("=").trim();
    }
  }
  // normalize list fields
  for (const d of byKey.values()) {
    d.add = dedupeCI(d.add);
    d.removeGroups = dedupeCI(d.removeGroups);
    if (d.namedGroups) d.namedGroups = dedupeCI(d.namedGroups);
    if (d.removeNamedGroups) d.removeNamedGroups = dedupeCI(d.removeNamedGroups);
    if (d.addSharedMailboxes) d.addSharedMailboxes = dedupeCI(d.addSharedMailboxes);
    if (d.removeSharedMailboxes) d.removeSharedMailboxes = dedupeCI(d.removeSharedMailboxes);
    if (d.removeLicenses) d.removeLicenses = dedupeCI(d.removeLicenses);
  }
  return [...byKey.values()];
}

// `../orchestrator` does not re-export `Mode` (only imports it internally from @prisma/client),
// so import it directly here.
import type { PlannedJob } from "../orchestrator";
import type { Mode } from "@prisma/client";
import { resolvePlannedConfigs } from "../profiles/plan-resolve";

export type ChangePlanSystem = { systemKey: string; mode: string; secretNames: string[]; requiresApproval: boolean };
export type ChangePlanClient = {
  systems: ChangePlanSystem[];
  identity?: unknown;
  personas?: unknown;
  globals?: unknown;
  locations?: unknown;
};

const DIR = new Set<string>(DIRECTORY_SYSTEMS);

// Build a target group set per directory by reusing the ONBOARD resolver with a payload that
// encodes the target persona/location. resolvePlannedConfigs writes `groups` (and `ou`) onto each
// directory job's config — exactly the "what should this persona have" computation we need.
export function targetGroupsForPersona(
  client: ChangePlanClient,
  toPersona?: string,
  toLocation?: string
): { groups: Record<string, string[]>; ou: Record<string, string> } {
  const payload: Record<string, unknown> = {};
  if (toPersona) payload.role = toPersona;
  if (toLocation) payload.location = toLocation;
  const seed: PlannedJob[] = client.systems
    .filter((s) => DIR.has(s.systemKey))
    .map((s, i) => ({ systemKey: s.systemKey, sequence: i, mode: "api" as Mode, requiresApproval: false, captureEvidence: false, intent: null, secretNames: s.secretNames, config: null, dependsOn: [] }));
  const resolved = resolvePlannedConfigs(client as never, payload, "onboard", seed);
  const groups: Record<string, string[]> = {};
  const ou: Record<string, string> = {};
  for (const j of resolved) {
    const cfg = (j.config ?? {}) as { groups?: unknown; ou?: unknown };
    if (Array.isArray(cfg.groups)) groups[j.systemKey] = cfg.groups.map(String);
    if (typeof cfg.ou === "string" && cfg.ou) ou[j.systemKey] = cfg.ou;
  }
  return { groups, ou };
}

const hasChange = (d: ChangeDiff): boolean =>
  d.add.length > 0 || d.removeGroups.length > 0 || d.reconcileGroups ||
  Boolean(d.moveToOu) || Boolean(d.attributes && Object.keys(d.attributes).length) ||
  Boolean(d.licenses?.length) || Boolean(d.removeLicenses?.length) ||
  Boolean(d.namedGroups?.length) || Boolean(d.removeNamedGroups?.length) ||
  Boolean(d.addSharedMailboxes?.length) || Boolean(d.removeSharedMailboxes?.length);

const isRemoval = (d: ChangeDiff): boolean =>
  d.removeGroups.length > 0 || d.reconcileGroups || Boolean(d.moveToOu) ||
  Boolean(d.removeLicenses?.length) || Boolean(d.removeNamedGroups?.length) || Boolean(d.removeSharedMailboxes?.length);

// Turn per-directory diffs into a topo-ordered PlannedJob[]. No identity pipeline (that is
// onboard/offboard-specific): a change touches only the systems that actually have a delta.
export function planChangeJobs(client: ChangePlanClient, diffs: ChangeDiff[]): PlannedJob[] {
  const active = new Map(client.systems.map((s) => [s.systemKey, s]));
  const jobs: PlannedJob[] = [];
  let seq = 0;
  for (const d of diffs) {
    if (!hasChange(d)) continue;
    const sys = active.get(d.systemKey);
    if (!sys) continue;
    const removal = isRemoval(d);
    const config = {
      groups: d.add,
      removeGroups: d.removeGroups,
      reconcileGroups: d.reconcileGroups,
      desiredGroups: d.desiredGroups,
      ...(d.moveToOu ? { moveToOu: d.moveToOu } : {}),
      ...(d.attributes ? { attributes: d.attributes } : {}),
      ...(d.licenses ? { licenses: d.licenses } : {}),
      ...(d.removeLicenses ? { removeLicenses: d.removeLicenses } : {}),
      ...(d.namedGroups ? { namedGroups: d.namedGroups } : {}),
      ...(d.removeNamedGroups ? { removeNamedGroups: d.removeNamedGroups } : {}),
      ...(d.addSharedMailboxes ? { addSharedMailboxes: d.addSharedMailboxes } : {}),
      ...(d.removeSharedMailboxes ? { removeSharedMailboxes: d.removeSharedMailboxes } : {}),
    };
    jobs.push({
      systemKey: d.systemKey,
      sequence: seq++,
      mode: (sys.mode as Mode) ?? "api",
      requiresApproval: removal || sys.requiresApproval, // removals/OU-move/reconcile, or a system the client always gates
      captureEvidence: removal,
      intent: removal ? "destructive" : null,
      secretNames: sys.secretNames,
      config,
      dependsOn: [],
    });
  }
  // A directory-sync step after AD, if the client models it (push on-prem group/OU edits to Entra).
  if (jobs.some((j) => j.systemKey === "active-directory") && active.has("directory-sync")) {
    const ds = active.get("directory-sync")!;
    jobs.push({ systemKey: "directory-sync", sequence: seq++, mode: (ds.mode as Mode) ?? "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: ds.secretNames, config: null, dependsOn: ["active-directory"] });
  }
  // Trailing closing step (mirrors onboard/offboard). Manual — the app writes the SN work note.
  jobs.push({ systemKey: "case-resolution", sequence: seq++, mode: "manual", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], config: null, dependsOn: [] });
  return jobs;
}
