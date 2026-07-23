// Go-live readiness — the declarative check registry (feature #6). Each check is DATA: an id, a scope
// (global vs per-client), whether a fail blocks the go/no-go gate, whether its signal is live or
// cached, and a PURE `evaluate` that maps an already-loaded Snapshot to a verdict. The registry never
// runs a probe itself — the loader (app/golive/_lib/loader.ts) batches every read once and hands the
// Snapshot in, so the whole page renders from one load and the evaluators unit-test without a DB.
//
// This file reuses the SHAPES of the existing signal helpers (runHealthChecks, rollupFleetM365Test,
// computeClientReadiness, migrateStatus, backupFreshness, the fleet-health online/build predicates) —
// it re-derives nothing. Adding a check is one entry in GLOBAL_CHECKS / PER_CLIENT_CHECKS.
import type { HealthResult, HealthStatus } from "@/lib/health/checks";
import type { FleetM365Status, FleetM365Tag } from "@/lib/jobs/fleet-m365-test";
import type { ReadinessTier } from "@/lib/clients/readiness";
import type { BackupFreshness } from "@/lib/jobs/backup-freshness";
import type { MigrationStatus } from "./migration-status";
import { migrateStatus, type MigrateStatusAgent } from "@/lib/agents/migrate-status";
import { AGENT_ONLINE_MS } from "@/lib/runner/reachability";
import { agentBuildIsCurrent } from "@/lib/jobs/agent-updates";

export type Verdict = "pass" | "warn" | "fail" | "na"; // na = not applicable / not configured
export type CheckScope = "global" | "per-client";
export type Liveness = "live" | "cached";

export type CheckResult = {
  id: string;
  verdict: Verdict;
  headline: string;
  detail: string;
  remediation?: string; // shown only on warn/fail — the actionable fix
  liveness: Liveness;
  blocking: boolean; // does a fail flip the overall verdict to NO-GO?
};

// One agent, reduced to what the global agent checks read. `migrate` is the shape migrateStatus wants.
export type AgentSnapshot = {
  id: string;
  clientId: string | null;
  lastSeenAtMs: number | null;
  version: string | null; // the content-hash build id the agent reported
  migrate: MigrateStatusAgent;
};

// One in-scope client's slice of the snapshot — what the per-client checks read.
export type ClientState = {
  slug: string;
  name: string;
  readinessTier: ReadinessTier;
  readinessSummary: string;
  // M365 credential health from the last sweep. null = this client has no M365-family system.
  m365: { status: FleetM365Status; tags: FleetM365Tag[]; missingPerms: number } | null;
  // Agent reachability over the client's ON-PREM systems. null = cloud-only (no own-agent needed).
  agentReach: { total: number; servable: number; reasons: string[] } | null;
};

export type Snapshot = {
  now: number;
  health: HealthResult[]; // runHealthChecks()
  agents: AgentSnapshot[]; // enabled agents (online-relevant subset)
  build: string; // runnerBuildId()
  migrationTarget: string | null; // AppSetting[agent_migration].targetUrl — null when no cutover in flight
  migrations: MigrationStatus;
  backups: BackupFreshness;
  wedgedJobs: number; // running jobs past the progress-stale cutoff (from lib/fleet/health predicates)
  m365SweepAgeMs: number | null; // age of the newest fleet M365 sweep (null = never swept)
  m365SweepStaleMs: number; // the staleness window the sweep uses (for the "re-run" hint)
  clients: ClientState[];
};

export type GlobalCheck = {
  id: string;
  scope: "global";
  blocking: boolean;
  liveness: Liveness;
  evaluate: (s: Snapshot) => CheckResult;
};
export type PerClientCheck = {
  id: string;
  scope: "per-client";
  blocking: boolean;
  liveness: Liveness;
  evaluate: (s: Snapshot, c: ClientState) => CheckResult;
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
const health = (s: Snapshot, name: string): HealthStatus | null => s.health.find((h) => h.name === name)?.status ?? null;
const healthDetail = (s: Snapshot, name: string): string => s.health.find((h) => h.name === name)?.detail ?? "";
const isOnline = (a: AgentSnapshot, now: number): boolean => a.lastSeenAtMs !== null && now - a.lastSeenAtMs <= AGENT_ONLINE_MS;

// ── global checks ───────────────────────────────────────────────────────────────────────────────
export const GLOBAL_CHECKS: GlobalCheck[] = [
  {
    id: "db", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => {
      const st = health(s, "PostgreSQL");
      const verdict: Verdict = st === "ok" ? "pass" : "fail";
      return { id: "db", verdict, headline: "Database reachable", detail: healthDetail(s, "PostgreSQL") || "no result", liveness: "live", blocking: true,
        remediation: verdict === "fail" ? "Postgres is unreachable — cases cannot be planned or dispatched. Check DATABASE_URL and the DB host." : undefined };
    },
  },
  {
    id: "delinea", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => {
      const base = health(s, "Delinea");
      const rights = health(s, "Delinea rights");
      let verdict: Verdict;
      if (base === "fail" || rights === "fail") verdict = "fail";
      else if (base === "ok" && rights === "ok") verdict = "pass";
      else if (base === "ok" && rights === "not_configured") verdict = "warn";
      else verdict = base === "not_configured" ? "fail" : "warn";
      return { id: "delinea", verdict, headline: "Delinea secrets resolvable", detail: `${healthDetail(s, "Delinea") || "—"} · rights: ${healthDetail(s, "Delinea rights") || "—"}`, liveness: "live", blocking: true,
        remediation: verdict === "fail" ? "The credential broker can't authenticate or read — runners will get no secrets. Check DELINEA_* and the broker account's rights." : verdict === "warn" ? "The write account isn't verifiable; reads work. Fine for running cases, blocks in-app secret creation." : undefined };
    },
  },
  {
    id: "servicenow", scope: "global", blocking: false, liveness: "live",
    evaluate: (s) => {
      const st = health(s, "ServiceNow");
      const verdict: Verdict = st === "ok" ? "pass" : st === "not_configured" ? "warn" : "fail";
      return { id: "servicenow", verdict, headline: "ServiceNow reachable", detail: healthDetail(s, "ServiceNow") || "not configured", liveness: "live", blocking: false,
        remediation: verdict !== "pass" ? "Work notes won't flush and intake won't sync — cases still run, but without their ServiceNow paper trail. Check SN_*." : undefined };
    },
  },
  {
    id: "azure-ai", scope: "global", blocking: false, liveness: "live",
    evaluate: (s) => {
      const st = health(s, "Azure OpenAI");
      const verdict: Verdict = st === "ok" ? "pass" : st === "not_configured" ? "na" : "warn";
      return { id: "azure-ai", verdict, headline: "Azure OpenAI reachable", detail: healthDetail(s, "Azure OpenAI") || "not configured", liveness: "live", blocking: false,
        remediation: verdict === "warn" ? "The LLM endpoint is misconfigured — AI-assist features degrade, core automation is unaffected. Check AZUREAI_*." : undefined };
    },
  },
  {
    id: "cred-expiry", scope: "global", blocking: false, liveness: "live",
    evaluate: (s) => {
      const st = health(s, "Credential expiry");
      const verdict: Verdict = st === "fail" ? "warn" : "pass"; // "fail" here = something expires within the critical window
      return { id: "cred-expiry", verdict, headline: "No credentials expiring imminently", detail: healthDetail(s, "Credential expiry") || "—", liveness: "live", blocking: false,
        remediation: verdict === "warn" ? "A tracked credential expires soon — rotate it before it lapses mid-case." : undefined };
    },
  },
  {
    id: "central-runner-online", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => {
      const central = s.agents.filter((a) => a.clientId === null && isOnline(a, s.now));
      const verdict: Verdict = central.length >= 1 ? "pass" : "fail";
      return { id: "central-runner-online", verdict, headline: "Central runner online", detail: `${central.length} central runner(s) online`, liveness: "live", blocking: true,
        remediation: verdict === "fail" ? "No central runner is heartbeating — cloud (M365/Google/etc.) jobs cannot be claimed at all. Start the central runner." : undefined };
    },
  },
  {
    id: "runner-build-sync", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => {
      const online = s.agents.filter((a) => isOnline(a, s.now));
      const current = online.filter((a) => agentBuildIsCurrent(a.version, s.build));
      let verdict: Verdict;
      if (online.length === 0) verdict = "na"; // no online agent to compare — central-runner-online owns that failure
      else if (current.length === 0) verdict = "fail";
      else if (current.length < online.length) verdict = "warn";
      else verdict = "pass";
      return { id: "runner-build-sync", verdict, headline: "Runner build in sync", detail: `${current.length} of ${online.length} online agent(s) on served build ${s.build.slice(0, 12)}`, liveness: "live", blocking: true,
        remediation: verdict === "fail" ? "No online agent is on the current build — claim() will refuse every job. Restart/update the agents so at least one converges." : verdict === "warn" ? "Some online agents are on an old build; they self-update. Dispatch still works on the current-build agents." : undefined };
    },
  },
  {
    id: "agent-url-converged", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => {
      // Inert on a normal day: with no migration target set there's no cutover to gate.
      if (!s.migrationTarget) return { id: "agent-url-converged", verdict: "na", headline: "Agents converged on the app URL", detail: "no migration target set — not a cutover window", liveness: "live", blocking: true };
      let converged = 0, pending = 0, failed = 0;
      for (const a of s.agents) {
        const st = migrateStatus(a.migrate, s.migrationTarget, s.now);
        if (st?.kind === "failed") failed++;
        else if (st?.kind === "migrated") converged++;
        else pending++; // queued / moving / moving-quiet / returned-old / not-yet-reported
      }
      const verdict: Verdict = failed > 0 ? "fail" : pending > 0 ? "warn" : "pass";
      return { id: "agent-url-converged", verdict, headline: "Agents converged on the app URL", detail: `${converged} converged · ${pending} pending · ${failed} failed (target ${s.migrationTarget})`, liveness: "live", blocking: true,
        remediation: verdict === "fail" ? "An agent failed to move to the new URL and is still on the old one — it will stop getting work after cutover. Check the Agents page." : verdict === "warn" ? "Some agents haven't reported in on the new URL yet — wait for them to converge before the first real case." : undefined };
    },
  },
  {
    id: "db-migrations", scope: "global", blocking: true, liveness: "live",
    evaluate: (s) => ({ id: "db-migrations", verdict: s.migrations.verdict, headline: "DB migrations applied", detail: s.migrations.detail, liveness: "live", blocking: true,
      remediation: s.migrations.verdict === "fail" ? "The DB schema doesn't match the deployed code — run `prisma migrate deploy` against the (Azure) database before going live." : s.migrations.verdict === "warn" ? "Couldn't verify the migration state — confirm the schema manually before the first case." : undefined }),
  },
  {
    id: "backups-fresh", scope: "global", blocking: false, liveness: "cached",
    evaluate: (s) => {
      const b = s.backups;
      const verdict: Verdict = !b.backupStale && b.backupOk ? "pass" : "warn";
      const age = b.backupAgeHours !== null ? `${Math.round(b.backupAgeHours)}h ago` : "never";
      return { id: "backups-fresh", verdict, headline: "Database backups fresh", detail: `last successful backup ${age} · drill ${b.drillStale ? "stale" : "ok"}`, liveness: "cached", blocking: false,
        remediation: verdict === "warn" ? "No fresh, verified backup — take a backup and confirm the restore drill before cutover so you can roll back." : undefined };
    },
  },
  {
    id: "wedged-jobs", scope: "global", blocking: false, liveness: "live",
    evaluate: (s) => {
      const verdict: Verdict = s.wedgedJobs === 0 ? "pass" : "warn";
      return { id: "wedged-jobs", verdict, headline: "No wedged jobs", detail: s.wedgedJobs === 0 ? "no stuck in-flight jobs" : `${s.wedgedJobs} running job(s) stopped narrating progress`, liveness: "live", blocking: false,
        remediation: verdict === "warn" ? "Jobs are wedged (past the progress-stale cutoff). Clear or reclaim them before adding real cases — see the fleet health board." : undefined };
    },
  },
];

// ── per-client checks ─────────────────────────────────────────────────────────────────────────────
export const PER_CLIENT_CHECKS: PerClientCheck[] = [
  {
    id: "client-creds-ready", scope: "per-client", blocking: false, liveness: "cached",
    evaluate: (_s, c) => {
      const verdict: Verdict = c.readinessTier === "ready" ? "pass" : c.readinessTier === "partial" ? "warn" : c.readinessTier === "no_systems" ? "na" : "fail";
      return { id: "client-creds-ready", verdict, headline: "Credentials wired & tested", detail: c.readinessSummary, liveness: "cached", blocking: false,
        remediation: verdict === "fail" ? "No credentials wired — this client can't run anything. Wire its Delinea references on the client page." : verdict === "warn" ? "Some systems are unwired, untested, or failing — finish setup or it will fail partway." : undefined };
    },
  },
  {
    id: "client-m365", scope: "per-client", blocking: false, liveness: "cached",
    evaluate: (_s, c) => {
      if (!c.m365) return { id: "client-m365", verdict: "na", headline: "M365 credential healthy", detail: "no M365-family system", liveness: "cached", blocking: false };
      const { status, tags, missingPerms } = c.m365;
      const hasNoCreds = tags.includes("no_creds");
      const hasMissingPerms = tags.includes("missing_perms");
      let verdict: Verdict;
      if (status === "fail" || hasMissingPerms || hasNoCreds) verdict = "fail";
      else if (status === "ok") verdict = tags.includes("over_permissioned") ? "warn" : "pass";
      else verdict = "warn"; // unverified / untested / running / pending
      const detail = `${status}${tags.length ? ` · ${tags.join(", ")}` : ""}${missingPerms ? ` · ${missingPerms} missing perm(s)` : ""}`;
      return { id: "client-m365", verdict, headline: "M365 credential healthy", detail, liveness: "cached", blocking: false,
        remediation: verdict === "fail" ? (hasNoCreds ? "No working M365 credential — set up the app registration (Fleet setup — M365)." : "The M365 credential fails or is missing permissions — correct it on Fleet setup — M365.") : verdict === "warn" ? "M365 not fully verified — run a fresh M365 sweep to confirm before cutover." : undefined };
    },
  },
  {
    id: "client-agent-reachable", scope: "per-client", blocking: true, liveness: "live",
    evaluate: (_s, c) => {
      if (!c.agentReach) return { id: "client-agent-reachable", verdict: "na", headline: "On-prem agent reachable", detail: "cloud-only — no own agent needed", liveness: "live", blocking: true };
      const { total, servable, reasons } = c.agentReach;
      const verdict: Verdict = servable === total ? "pass" : "fail";
      return { id: "client-agent-reachable", verdict, headline: "On-prem agent reachable", detail: `${servable} of ${total} on-prem system(s) servable`, liveness: "live", blocking: true,
        remediation: verdict === "fail" ? (reasons[0] ?? "No online, capable agent for this client's on-prem systems — start its network agent.") : undefined };
    },
  },
];
