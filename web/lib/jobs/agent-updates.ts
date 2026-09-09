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

// How many CONSECUTIVE auto-updates an agent may be issued without its reported build changing
// before the app stops asking. Three is deliberate: one attempt can lose a race with a restart, two
// is bad luck, three in a row is an agent whose pull cannot take. Every attempt exits the runner
// process, so the cost of "just keep retrying" is an agent that is killed every 90 seconds.
export const AGENT_UPDATE_MAX_ATTEMPTS = 3;

// Decide what the heartbeat should do about a stale agent's auto-update, given how many consecutive
// attempts have already failed to move it. Pure, so the rule is testable without a database.
//
//   - "update"  — issue the self-update and count the attempt
//   - "stalled" — stop asking: this agent has burned its attempts against THIS build. It keeps
//                 running on the build it has; the Agents page surfaces it for a human
//
// A change in the served build resets the count, because a new bundle is a genuinely new thing to
// try — the previous failure says nothing about whether this one will land. Without that reset, an
// agent stalled once would stay stalled through every future release.
export function autoUpdateDecision(args: {
  attempts: number;
  stalledBuild: string | null | undefined;
  build: string;
}): { action: "update" | "stalled"; attempts: number; reset: boolean } {
  const reset = !!args.stalledBuild && args.stalledBuild !== args.build;
  const attempts = reset ? 0 : args.attempts;
  if (attempts >= AGENT_UPDATE_MAX_ATTEMPTS) return { action: "stalled", attempts, reset };
  return { action: "update", attempts: attempts + 1, reset };
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
