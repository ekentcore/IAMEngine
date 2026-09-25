// Per-lane "depends on" (FR #122). The planner already orders each lane by config.dependsOn.<action>
// when present, falling back to the system-level dependsOn (lib/orchestrator.ts). Only the editor was
// missing: it showed one list for both lanes. These two helpers are the editor's read and write sides.
//
// Storage stays backward-compatible: when both lanes want the same order, it is written exactly as
// before (dependsOn, no per-lane override); only when they differ does config.dependsOn get
// { onboard, offboard }, with the top-level dependsOn set to the onboard list as the fallback for any
// reader that doesn't know about lanes.
export type LaneDeps = { onboard: string[]; offboard: string[] };

function clean(xs: unknown): string[] | null {
  return Array.isArray(xs) ? [...new Set(xs.map(String).map((s) => s.trim()).filter(Boolean))] : null;
}

export function readLaneDeps(dependsOn: string[] | null | undefined, config: unknown): LaneDeps {
  const base = clean(dependsOn) ?? [];
  const lanes = ((config ?? {}) as { dependsOn?: Record<string, unknown> }).dependsOn ?? {};
  return { onboard: clean(lanes.onboard) ?? base, offboard: clean(lanes.offboard) ?? base };
}

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function writeLaneDeps(deps: LaneDeps, config: Record<string, unknown>): { dependsOn: string[]; config: Record<string, unknown> } {
  const onboard = clean(deps.onboard) ?? [];
  const offboard = clean(deps.offboard) ?? [];
  const { dependsOn: _prev, ...rest } = config;
  if (same(onboard, offboard)) return { dependsOn: onboard, config: rest };
  return { dependsOn: onboard, config: { ...rest, dependsOn: { onboard, offboard } } };
}
