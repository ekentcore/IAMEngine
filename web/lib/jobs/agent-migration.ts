// Operator-driven app-URL migration: decide whether to tell an agent to move to a new base URL.
// Pure so it is unit-testable (the repo has no DB-backed tests). Consumed by runner-service.heartbeat.
export const AGENT_MIGRATION_KEY = "agent_migration";

export type AgentMigrationSetting = { enabled?: boolean; targetUrl?: string };

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
