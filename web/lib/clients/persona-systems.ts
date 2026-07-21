import type { Persona, Fragment } from "./rules";

// FR #0000022 — a `by_persona` system is included for a hire only when its key is present in the
// selected persona's bundle (`persona.systems` for onboard, `persona.offboardSystems` for offboard);
// the planner gate reads exactly that (web/lib/orchestrator.ts, web/lib/profiles/plan-resolve.ts).
// These pure helpers let the Roles & Rules editor make that membership first-class — an explicit
// per-persona checklist — instead of it being an accidental side effect of adding a group/OU/attr.

type Lane = "onboard" | "offboard";
const bundleKey = (lane: Lane): "systems" | "offboardSystems" => (lane === "onboard" ? "systems" : "offboardSystems");

// The systems in "by persona" mode for a lane — the ones whose inclusion is decided by persona
// membership, and therefore the ones the checklist should offer.
export function byPersonaSystemKeys(
  systemKeys: string[],
  systemLanes: Record<string, { onboard: string; offboard: string }>,
  lane: Lane,
): string[] {
  return systemKeys.filter((k) => systemLanes[k]?.[lane] === "by_persona");
}

// Membership = key presence in the bundle (an empty `{}` fragment counts — membership with no config).
export function personaHasSystem(persona: Persona | undefined, key: string, lane: Lane): boolean {
  const bundle = persona?.[bundleKey(lane)] as Record<string, unknown> | undefined;
  return !!bundle && Object.prototype.hasOwnProperty.call(bundle, key);
}

// Toggle a persona's membership of a system, returning a NEW persona (never mutates). Adding preserves
// an existing fragment (so checking a system you've already configured keeps its groups/OU/attrs);
// removing drops the key entirely (the persona no longer receives that system).
export function withPersonaSystem(persona: Persona | undefined, key: string, on: boolean, lane: Lane): Persona {
  const bk = bundleKey(lane);
  const cur: Record<string, Fragment> = { ...((persona?.[bk] as Record<string, Fragment>) ?? {}) };
  if (on) cur[key] = cur[key] ?? {};
  else delete cur[key];
  return { ...(persona ?? {}), [bk]: cur };
}
