// Operator-driven app-URL migration: decide whether to tell an agent to move to a new base URL.
// Pure so it is unit-testable (the repo has no DB-backed tests). Consumed by runner-service.heartbeat.
export const AGENT_MIGRATION_KEY = "agent_migration";

// proofAgentId: the "prove it on one agent first" canary. While set (and fleet disabled), the
// Agents page watches that agent; when it converges the operator is offered "move all the others
// now", and a migrate-failed writeback clears it server-side so no stale prompt lingers.
export type AgentMigrationSetting = { enabled?: boolean; targetUrl?: string; proofAgentId?: string | null };

// What a settings-form save ({ enabled, targetUrl }) does to the stored setting: the proof pointer
// survives only while the target it was proving is still the target — changing the URL moots the
// proof, so it clears rather than letting an old canary "confirm" a URL it never visited.
export function nextMigrationSetting(
  existing: AgentMigrationSetting | null,
  next: { enabled: boolean; targetUrl: string }
): AgentMigrationSetting {
  const sameTarget = normalizeUrl(existing?.targetUrl) === normalizeUrl(next.targetUrl);
  return { enabled: next.enabled, targetUrl: next.targetUrl, proofAgentId: sameTarget ? existing?.proofAgentId ?? null : null };
}

// Compare base URLs forgivingly: trailing slash and case must not create a false mismatch that would
// make an already-migrated agent look un-converged (→ endless migrate instructions).
export function normalizeUrl(u: string | null | undefined): string {
  return (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export function migrateDecision(args: {
  setting: AgentMigrationSetting | null;
  agentMigrateRequested: boolean;
  reportedUrl: string | null;
}): { migrate: boolean; targetUrl: string | null; converged: boolean } {
  const rawTarget = args.setting?.targetUrl?.trim() || null;
  const target = normalizeUrl(rawTarget);
  if (!target) return { migrate: false, targetUrl: null, converged: false };
  const current = normalizeUrl(args.reportedUrl);
  if (current && current === target) return { migrate: false, targetUrl: rawTarget, converged: true };
  const wants = args.agentMigrateRequested || args.setting?.enabled === true;
  return { migrate: wants, targetUrl: rawTarget, converged: false };
}
