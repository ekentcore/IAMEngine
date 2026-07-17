// "Does THIS client have a reachable, capable runner right now" — one shared definition of the
// online + scope + capability rules that dispatch actually uses, so the guided-setup wizard can tell
// an operator whether an on-prem credential can even be live-tested before they wire it.
//
// This mirrors the claim filter (runner-service.ts claim()) and the run-report reason block
// (run-report.ts:586-654): an agent counts only if it heartbeated within the 90s window, is in scope
// for the system (on-prem systems run ONLY on the client's own agent; cloud systems on central OR the
// client's own), and REPORTS the capability the system needs (e.g. the ActiveDirectory/RSAT module).
// It deliberately does NOT apply the stale-build guard — for "can I test this credential" the operator
// cares that a capable agent is present, not that it's on the newest build.
import type { PrismaClient } from "@prisma/client";
import { ALWAYS_ON_PREM_SYSTEMS, systemIsOnPrem } from "@/lib/cases/case-secrets";
import { agentCanRun, parseCapabilities, BROWSER_SYSTEMS } from "@/lib/runner/capabilities";

// The heartbeat freshness window. Matches ONLINE_MS in runner-service.ts and the 90_000 literals in
// repository.ts / run-report.ts — an agent is "online" if it polled within this many ms.
export const AGENT_ONLINE_MS = 90_000;

export type RunnerReach = {
  systemKey: string;
  servable: boolean; // an online, in-scope, capable agent can run this system right now
  needsOwnAgent: boolean; // on-prem / cloud-on-own-agent → must be the client's OWN agent, not central
  centralOnline: boolean; // a central (clientId null) agent is online
  ownAgentOnline: boolean; // this client's own agent is online (any capability)
  reason?: string; // operator-facing "why not", present only when servable === false
};

// The minimal shape of the agent rows and client row we read. Kept structural so the pure eligibility
// logic (computeReach) can be unit-tested without a Prisma client.
export type OnlineAgentRow = { clientId: string | null; name: string | null; capabilities: unknown };
// The Prisma delegates this reads. `Pick` of the real client so the app passes `db` directly; unit
// tests pass a hand-rolled stub cast through `as any`.
type ReachDb = Pick<PrismaClient, "agent" | "client">;

// Pure core: given the online agents + whether the client pins cloud work to its own agent, decide
// each system's reachability. Separated from the DB read so it unit-tests directly.
export function computeReach(
  onlineAgents: OnlineAgentRow[],
  clientId: string,
  systemKeys: string[],
  opts: { pinsToOwnAgent: boolean; clientHasOnPremAd: boolean },
): Record<string, RunnerReach> {
  const centralOnline = onlineAgents.some((a) => a.clientId === null);
  const ownAgentOnline = onlineAgents.some((a) => a.clientId === clientId);

  const out: Record<string, RunnerReach> = {};
  for (const systemKey of systemKeys) {
    const isBrowser = BROWSER_SYSTEMS.includes(systemKey);
    // Host affinity, same rule as the claim filter: on-prem systems (AD/Exchange-hybrid/dir-sync), and
    // every step of a cloud-on-own-agent client, are claimed ONLY by the client's own agent.
    const needsOwnAgent = !isBrowser && (systemIsOnPrem(systemKey, opts.clientHasOnPremAd) || opts.pinsToOwnAgent);
    const eligible = onlineAgents.filter((a) => (needsOwnAgent ? a.clientId === clientId : a.clientId === null || a.clientId === clientId));
    // Capability gate: an ALWAYS_ON_PREM system needs the agent to REPORT it can run it; a browser
    // system needs the 'browser' capability. Everything else is runnable by any in-scope agent.
    const runnable = ALWAYS_ON_PREM_SYSTEMS.includes(systemKey)
      ? eligible.filter((a) => agentCanRun(systemKey, parseCapabilities(a.capabilities)))
      : isBrowser
        ? eligible.filter((a) => {
            const caps = parseCapabilities(a.capabilities);
            return !!caps && caps.includes("browser");
          })
        : eligible;

    let reason: string | undefined;
    if (eligible.length === 0) {
      reason = needsOwnAgent
        ? "no runner online for this client — this runs on the client's own on-prem agent; check the Agents page"
        : "no runner online — check the Agents page";
    } else if (runnable.length === 0) {
      const names = [...new Set(eligible.map((a) => a.name).filter(Boolean))].join(", ");
      reason =
        systemKey === "active-directory"
          ? `${names || "the client's agent"} is online but can't run Active Directory — the ActiveDirectory (RSAT) module isn't loaded there; install RSAT-AD-PowerShell and restart it`
          : isBrowser
            ? "no browser-capable runner is online (this runs on the central runner's Node/Playwright); check the Agents page"
            : `an agent is online but none reports the ${systemKey} capability yet`;
    }
    out[systemKey] = { systemKey, servable: runnable.length > 0, needsOwnAgent, centralOnline, ownAgentOnline, reason };
  }
  return out;
}

// DB-backed entry point: load the online agents + the client's own-agent pinning, then compute. When
// `clientHasOnPremAd` isn't given it's inferred from the systemKeys (an AD/sync key implies the client
// is on-prem), which is exactly right for the setup wizard where the keys come from the client's systems.
export async function clientRunnerReachability(
  db: ReachDb,
  clientId: string,
  systemKeys: string[],
  opts: { clientHasOnPremAd?: boolean } = {},
): Promise<Record<string, RunnerReach>> {
  if (systemKeys.length === 0) return {};
  const onlineAgents = await db.agent.findMany({
    where: { enabled: true, deletedAt: null, lastSeenAt: { gt: new Date(Date.now() - AGENT_ONLINE_MS) } },
    select: { clientId: true, name: true, capabilities: true },
  });
  const clientRow = await db.client.findUnique({ where: { id: clientId }, select: { runCloudOnOwnAgent: true } });
  const pinsToOwnAgent = Boolean(clientRow?.runCloudOnOwnAgent) && onlineAgents.some((a) => a.clientId === clientId);
  const clientHasOnPremAd = opts.clientHasOnPremAd ?? systemKeys.some((k) => ALWAYS_ON_PREM_SYSTEMS.includes(k));
  return computeReach(onlineAgents, clientId, systemKeys, { pinsToOwnAgent, clientHasOnPremAd });
}

type SecretReachDb = Pick<PrismaClient, "agent" | "client" | "clientSystem">;

// "Can the client's runner test THIS credential right now" — reachability aggregated over the systems
// that reference a secret. Used as the advisory agent-probe for on-prem credentials (ad-dc) in the
// guided setup: servable if ANY referencing system has a reachable, capable agent.
export async function secretRunnerReach(
  db: SecretReachDb,
  clientId: string,
  secretName: string,
): Promise<{ servable: boolean; reason?: string; systemKeys: string[] }> {
  const systems = await db.clientSystem.findMany({ where: { clientId, secretNames: { has: secretName } }, select: { systemKey: true } });
  const systemKeys = [...new Set(systems.map((s) => s.systemKey))];
  if (systemKeys.length === 0) return { servable: false, reason: "no system references this credential yet", systemKeys };
  const reach = await clientRunnerReachability(db, clientId, systemKeys);
  const servable = systemKeys.some((k) => reach[k]?.servable);
  const reason = servable ? undefined : systemKeys.map((k) => reach[k]?.reason).find(Boolean) ?? "no runner online for this client";
  return { servable, reason, systemKeys };
}
