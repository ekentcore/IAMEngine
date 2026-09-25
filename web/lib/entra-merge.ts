// FR #117: plan `entra` and `m365` as ONE step when a client runs both in the same lane.
//
// They are the same executor — the runner's dispatch table is literally $DISPATCH['entra'] =
// $DISPATCH['m365'] — so a client with both ran the M365 module twice per offboard: block sign-in,
// revoke sessions, strip groups and MFA, then do it all again. Profiles split the lane config between
// them (m365: block sign-in + licence; entra: revoke sessions + app access), so the merged step takes
// the UNION of the two lane configs, m365 winning a conflict.
//
// The one deliberate split was licence timing: `removeLicense: { defer: true, removedBy: "entra" }` on
// the m365 lane (MarketScience) made the licence come off in the later entra step, after Exchange had
// converted the mailbox. The planner now enforces "exchange before m365/entra" on every offboard
// (OFFBOARD safety invariant in orchestrator.ts), so the merged m365 step already runs after the
// conversion — it takes entra's removeLicense instead of deferring to a step that no longer exists.
//
// An entra-only client (no m365 in the lane) is untouched, and cases planned before this keep their jobs.
import type { ClientSystem } from "@prisma/client";

type Lane = "onboard" | "offboard";
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// Deep merge, `winner` taking precedence on a conflict; arrays are unioned (groups lists etc.).
function mergeInto(loser: unknown, winner: unknown): unknown {
  if (isObj(loser) && isObj(winner)) {
    const out: Obj = { ...loser };
    for (const [k, v] of Object.entries(winner)) out[k] = k in loser ? mergeInto(loser[k], v) : v;
    return out;
  }
  if (Array.isArray(loser) && Array.isArray(winner)) return [...new Set([...loser, ...winner])];
  return winner === undefined ? loser : winner;
}

const PAIR = new Set(["m365", "entra"]);
const LANES: Lane[] = ["onboard", "offboard"];

// `removeLicense: { removedBy: "entra" | "m365" }` hands the licence to the other half of the pair — which,
// once merged, is this very step. The runner defers on any removedBy other than its own system key (and on
// defer: true), so left in place it would keep the licence on the leaver with no step to remove it.
const defersToPair = (rl: unknown) => isObj(rl) && PAIR.has(String(rl.removedBy ?? ""));

function mergeLane(m365Lane: unknown, entraLane: unknown): unknown {
  if (entraLane == null) return m365Lane;
  if (m365Lane == null) return isObj(entraLane) && defersToPair(entraLane.removeLicense) ? { ...entraLane, removeLicense: true } : entraLane;
  const merged = mergeInto(entraLane, m365Lane) as Obj;
  // Licence timing (see the header): a removal either side deferred to the pair is the merged step's.
  // Take whichever side actually removes it (m365 first), else plain removal. Not deep-merged: that
  // would carry the deferral's defer/removedBy into the real removal.
  const mRl = isObj(m365Lane) ? m365Lane.removeLicense : undefined;
  const eRl = isObj(entraLane) ? entraLane.removeLicense : undefined;
  if (defersToPair(mRl) || defersToPair(eRl)) {
    merged.removeLicense = [mRl, eRl].find((v) => v !== undefined && !defersToPair(v)) ?? true;
  }
  return merged;
}

// A side's approval/evidence flag for a lane: its per-lane map is authoritative when it has one (as in
// planCase), otherwise the column — a systems-editor row carries only the column.
const laneFlag = (map: unknown, column: boolean, lane: Lane) => (isObj(map) ? Boolean(map[lane]) : column);

// A side's deps for a lane, as planCase reads them: the per-lane override, else the shared column.
function laneDeps(s: ClientSystem, lane: Lane): string[] {
  const l = (s.config as Obj | null)?.dependsOn;
  return isObj(l) && Array.isArray(l[lane]) ? (l[lane] as unknown[]).map(String) : s.dependsOn;
}

// The systems that (transitively) wait on m365 or entra in this lane. The merged step can't keep a dep on
// one of these from EITHER side — it would wait on itself (exchange dependsOn m365 + entra dependsOn
// exchange; or m365 dependsOn exchange + exchange dependsOn entra). Dropping them, and nothing else, keeps
// the merge cycle-free for any acyclic input: every path back to the merged step runs through one of them.
// Whichever half ran first sets the position — its dependents still run after the merged step.
function dependentsOfPair(active: ClientSystem[], lane: Lane): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of active) {
      if (PAIR.has(s.systemKey) || out.has(s.systemKey)) continue;
      if (laneDeps(s, lane).some((d) => PAIR.has(d) || out.has(d))) { out.add(s.systemKey); grew = true; }
    }
  }
  return out;
}

function mergeConfig(m365: unknown, entra: unknown): Obj | null {
  if (!isObj(m365) && !isObj(entra)) return null;
  const m = isObj(m365) ? m365 : {};
  const e = isObj(entra) ? entra : {};
  const out: Obj = { ...(mergeInto(e, m) as Obj) };
  for (const lane of LANES) {
    const v = mergeLane(m[lane], e[lane]);
    if (v === undefined) delete out[lane]; else out[lane] = v;
  }
  // Intent: destructive on a lane if either side was.
  if (isObj(m.intent) || isObj(e.intent)) {
    const mi = (isObj(m.intent) ? m.intent : {}) as Obj;
    const ei = (isObj(e.intent) ? e.intent : {}) as Obj;
    const intent: Obj = { ...ei, ...mi };
    for (const lane of ["onboard", "offboard"]) if (mi[lane] === "destructive" || ei[lane] === "destructive") intent[lane] = "destructive";
    out.intent = intent;
  }
  return out;
}

const swapEntra = (keys: string[]) => [...new Set(keys.map((k) => (k === "entra" ? "m365" : k)))];

// Returns the active systems with entra folded into m365 — or unchanged when not both present, or when
// their modes differ: a manual m365 (a human strips the licence and groups) folded into an automated entra
// would run that whole lane unattended, and the reverse would stop automated work being automated. Either
// way the two steps stay exactly as they were before FR #117.
export function mergeEntraIntoM365(active: ClientSystem[]): ClientSystem[] {
  const m365 = active.find((s) => s.systemKey === "m365");
  const entra = active.find((s) => s.systemKey === "entra");
  if (!m365 || !entra || m365.mode !== entra.mode) return active;
  const mergedConfig = mergeConfig(m365.config, entra.config) ?? {};
  // The merged step's own deps, per lane: each side's EFFECTIVE deps (its lane override, else its shared
  // deps — a lane override on one side must not drop the other side's shared ones), minus the pair, minus
  // any dep that itself waits on the pair (see dependentsOfPair). Written as explicit lane lists so
  // planCase reads exactly this; the column is their union.
  const laneLists: Obj = {};
  for (const lane of LANES) {
    const after = dependentsOfPair(active, lane);
    laneLists[lane] = [...new Set([...laneDeps(m365, lane), ...laneDeps(entra, lane)])].filter((d) => !PAIR.has(d) && !after.has(d));
  }
  mergedConfig.dependsOn = laneLists;
  const deps = [...new Set(LANES.flatMap((l) => laneLists[l] as string[]))];
  // Approval/evidence: per lane, set if EITHER side set it (map or column) — merging must never drop a gate.
  const mc = isObj(m365.config) ? m365.config : {};
  const ec = isObj(entra.config) ? entra.config : {};
  for (const [key, mCol, eCol] of [
    ["requiresApproval", m365.requiresApproval, entra.requiresApproval],
    ["captureEvidence", m365.captureEvidence, entra.captureEvidence],
  ] as const) {
    if (!isObj(mc[key]) && !isObj(ec[key])) continue; // neither has a map: planCase reads the OR'd column
    mergedConfig[key] = Object.fromEntries(LANES.map((l) => [l, laneFlag(mc[key], mCol, l) || laneFlag(ec[key], eCol, l)]));
  }
  const merged: ClientSystem = {
    ...m365,
    dependsOn: deps,
    requiresApproval: m365.requiresApproval || entra.requiresApproval,
    captureEvidence: m365.captureEvidence || entra.captureEvidence,
    secretNames: [...new Set([...m365.secretNames, ...entra.secretNames])],
    config: mergedConfig as ClientSystem["config"],
  };
  // Everything that waited on entra now waits on the merged m365 step.
  return active
    .filter((s) => s.systemKey !== "entra")
    .map((s) => {
      if (s.systemKey === "m365") return merged;
      const cfg = s.config as Obj | null;
      const laneDeps = isObj(cfg?.dependsOn) ? cfg!.dependsOn as Obj : null;
      const touches = s.dependsOn.includes("entra") || (laneDeps && Object.values(laneDeps).some((l) => Array.isArray(l) && l.includes("entra")));
      if (!touches) return s;
      const nextCfg = laneDeps
        ? { ...cfg, dependsOn: Object.fromEntries(Object.entries(laneDeps).map(([k, l]) => [k, Array.isArray(l) ? swapEntra(l.map(String)) : l])) }
        : cfg;
      return { ...s, dependsOn: swapEntra(s.dependsOn), config: nextCfg as ClientSystem["config"] };
    });
}
