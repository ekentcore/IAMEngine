import type { PrismaClient } from "@prisma/client";
import { runnerBuildId } from "@/lib/runner/bundle";

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
  const upToDate = (v: string | null) => !!v && /^[0-9a-f]{6,}$/.test(v) && v === build;
  return agents.filter((a) => !upToDate(a.version)).length;
}
