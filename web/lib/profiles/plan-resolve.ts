// Plan-time resolution: for a v2.1 client (has personas/globals), flatten each onboard job's config
// by merging globals + selected persona + the system's own lane config through the resolver. v2.0
// clients (no personas/globals) pass through unchanged. Offboard identifies an existing user, so no
// persona/role config applies.
import { buildPlanContext } from "./context";
import { resolveSystemConfig } from "./resolve";
import type { PlannedJob } from "../orchestrator";

type PlanClient = { personas?: unknown; globals?: unknown; locations?: unknown };

export function resolvePlannedConfigs(
  client: PlanClient,
  payload: Record<string, unknown>,
  action: string,
  planned: PlannedJob[]
): PlannedJob[] {
  const personas = (client.personas ?? null) as Record<string, unknown> | null;
  const globals = (client.globals ?? null) as Record<string, Record<string, unknown>> | null;
  if (action !== "onboard" || (!personas && !globals)) return planned;

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
}
