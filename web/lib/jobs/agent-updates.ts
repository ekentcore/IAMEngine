import type { PrismaClient } from "@prisma/client";
import { runnerBuildId } from "@/lib/runner/bundle";

// AppSetting key for auto-updating stale agents on heartbeat ({ enabled: boolean }, default ON).
export const AGENT_AUTO_UPDATE_KEY = "agent_auto_update";

// The single "is this agent on the served build?" rule, shared by the outdated count and the
// heartbeat auto-updater: a valid build-hash version equal to the served build is current; a null /
// legacy / mismatched version is stale.
export function agentBuildIsCurrent(version: string | null | undefined, build: string): boolean {
  return !!version && /^[0-9a-f]{6,}$/.test(version) && version === build;
}

// How many enabled, checked-in runners are NOT on the build the app currently serves — so any page
// can flag "an update is available". Mirrors the Agents page's "updatable" rule: a valid build-hash
// version equal to the served build is up to date; a null / legacy / mismatched version is outdated.
// Only counts agents that have actually checked in (lastSeenAt set) so a freshly-enrolled-but-never-
// started one doesn't trigger the banner.
export async function outdatedAgentCount(db: PrismaClient): Promise<number> {
  const build = runnerBuildId();
  const agents = await db.agent.findMany({
    where: { enabled: true, deletedAt: null, lastSeenAt: { not: null } },
    select: { version: true },
  });
  return agents.filter((a) => !agentBuildIsCurrent(a.version, build)).length;
}
