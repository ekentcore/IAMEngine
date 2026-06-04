// Plan-time resolution: for a v2.1 client (has personas/globals), flatten each onboard job's config
// by merging globals + selected persona + the system's own lane config through the resolver. v2.0
// clients (no personas/globals) pass through unchanged. Offboard identifies an existing user, so no
// persona/role config applies.
import { buildPlanContext } from "./context";
import { resolveSystemConfig } from "./resolve";
import type { PlannedJob } from "../orchestrator";

type PlanClient = { personas?: unknown; globals?: unknown; locations?: unknown };

// Directory systems whose groups can be mirrored from a reference user (the runner resolves the
// reference user's live memberOf at execution time and unions it in).
const DIRECTORY_SYSTEMS = new Set(["active-directory", "entra"]);

export function resolvePlannedConfigs(
  client: PlanClient,
  payload: Record<string, unknown>,
  action: string,
  planned: PlannedJob[]
): PlannedJob[] {
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
