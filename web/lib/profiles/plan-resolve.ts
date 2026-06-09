// Plan-time resolution: for a v2.1 client (has personas/globals), flatten each job's config by
// merging globals + selected persona + the system's own lane config through the resolver. v2.0
// clients (no personas/globals) pass through unchanged. Onboard resolves the ONBOARD fragments
// (add groups / place OU / set attrs); offboard resolves the OFFBOARD fragments with offboard
// semantics (remove groups / move OU / set attrs).
import { buildPlanContext } from "./context";
import { resolveSystemConfig } from "./resolve";
import type { PlannedJob } from "../orchestrator";

type PlanClient = { personas?: unknown; globals?: unknown; globalsOffboard?: unknown; locations?: unknown };

// Directory systems whose groups can be mirrored from a reference user (the runner resolves the
// reference user's live memberOf at execution time and unions it in). AD/entra mirror on-prem +
// synced groups; m365 mirrors the reference user's CLOUD-only Entra groups (cloud licensing groups,
// distribution/M365 groups) that AD sync never covers.
const DIRECTORY_SYSTEMS = new Set(["active-directory", "entra", "m365", "exchange"]);

// OFFBOARD resolution: resolve globalsOffboard + persona.offboardSystems and map the onboard-shaped
// keys to offboard semantics on the job config (groups -> removeGroups, ou -> moveToOu, attributes ->
// offboardAttributes). Additive — onboard config keys the runner already honors are untouched.
function resolveOffboardConfigs(client: PlanClient, payload: Record<string, unknown>, planned: PlannedJob[]): PlannedJob[] {
  const globalsOff = (client.globalsOffboard ?? null) as Record<string, Record<string, unknown>> | null;
  const personas = (client.personas ?? null) as Record<string, unknown> | null;
  if (!globalsOff && !personas) return planned;
  const { context, persona } = buildPlanContext(payload, { personas: personas as never, locations: client.locations as never });
  const personaOff = (persona?.def as { offboardSystems?: Record<string, unknown> } | undefined)?.offboardSystems ?? null;
  return planned.map((j) => {
    const gOff = globalsOff?.[j.systemKey] ?? null;
    const pOff = (personaOff?.[j.systemKey] as Record<string, unknown> | undefined) ?? null;
    if (!gOff && !pOff) return j;
    const off = resolveSystemConfig(j.systemKey, { globals: gOff as never, persona: pOff as never, own: null }, context);
    const cfg: Record<string, unknown> = { ...((j.config as Record<string, unknown> | null) ?? {}) };
    if (Array.isArray(off.groups) && off.groups.length) cfg.removeGroups = off.groups;
    if (typeof off.ou === "string" && off.ou) cfg.moveToOu = off.ou;
    if (off.attributes && typeof off.attributes === "object" && Object.keys(off.attributes as object).length) cfg.offboardAttributes = off.attributes;
    return { ...j, config: cfg };
  });
}

export function resolvePlannedConfigs(
  client: PlanClient,
  payload: Record<string, unknown>,
  action: string,
  planned: PlannedJob[]
): PlannedJob[] {
  if (action === "offboard") return resolveOffboardConfigs(client, payload, planned);
  if (action !== "onboard") return planned;

  const personas = (client.personas ?? null) as Record<string, unknown> | null;
  const globals = (client.globals ?? null) as Record<string, Record<string, unknown>> | null;
  // "mirror <user>": copy a reference user's group memberships (live AD state → resolved by the
  // runner). Applies to v2.0 and v2.1 clients alike, so it's injected independently of personas.
  const mirror = typeof payload.mirrorPermissionsFromUser === "string" && payload.mirrorPermissionsFromUser.trim()
    ? payload.mirrorPermissionsFromUser.trim() : null;

  // v2.1 resolution (persona/globals → flattened config) only when the client has those blocks.
  const resolved = (!personas && !globals)
    ? planned
    : (() => {
        const { context, persona } = buildPlanContext(payload, { personas: personas as never, locations: client.locations as never });
        return planned.map((j) => ({
          ...j,
          config: resolveSystemConfig(
            j.systemKey,
            {
              globals: globals?.[j.systemKey] ?? null,
              persona: (persona?.def?.systems?.[j.systemKey] as Record<string, unknown> | undefined) ?? null,
              own: (j.config as Record<string, unknown> | null) ?? null,
            },
            context
          ),
        }));
      })();

  if (!mirror) return resolved;
  return resolved.map((j) =>
    DIRECTORY_SYSTEMS.has(j.systemKey)
      ? { ...j, config: { ...((j.config as Record<string, unknown> | null) ?? {}), mirrorFromUser: mirror } }
      : j
  );
}
