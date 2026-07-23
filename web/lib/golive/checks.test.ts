import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_CHECKS, PER_CLIENT_CHECKS, type Snapshot, type ClientState, type AgentSnapshot } from "./checks";
import type { HealthResult, HealthStatus } from "@/lib/health/checks";
import { AGENT_ONLINE_MS } from "@/lib/runner/reachability";

const NOW = 1_000_000_000_000;
const BUILD = "a1b2c3d4e5f6";

const HEALTH_NAMES = ["PostgreSQL", "Redis", "Delinea", "Delinea rights", "ServiceNow", "Azure OpenAI", "Credential expiry"] as const;
function health(overrides: Partial<Record<string, HealthStatus>> = {}): HealthResult[] {
  return HEALTH_NAMES.map((name) => ({ name, status: overrides[name] ?? "ok", detail: "", latencyMs: 1 }));
}

function onlineAgent(id: string, clientId: string | null, version: string | null): AgentSnapshot {
  return { id, clientId, lastSeenAtMs: NOW, version, migrate: emptyMigrate() };
}
function emptyMigrate() {
  return { migrateRequested: false, migrateRequestedBy: null, migrateDeliveredAt: null, migratedAt: null, migrateError: null, lastSeenAt: new Date(NOW).toISOString(), currentAppUrl: null };
}

function base(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    now: NOW,
    health: health(),
    agents: [onlineAgent("central", null, BUILD)],
    build: BUILD,
    migrationTarget: null,
    migrations: { verdict: "pass", expected: 3, applied: 3, missing: [], rolledBack: [], detail: "all 3 migrations applied" },
    backups: { lastBackupAt: new Date(NOW).toISOString(), backupOk: true, backupAgeHours: 2, backupStale: false, lastUploadAt: null, blobOk: true, lastDrillAt: null, drillOk: true, drillAgeDays: 1, drillStale: false, healthy: true },
    wedgedJobs: 0,
    m365SweepAgeMs: 60_000,
    m365SweepStaleMs: 600_000,
    clients: [],
    ...overrides,
  };
}

const g = (id: string) => GLOBAL_CHECKS.find((c) => c.id === id)!;
const pc = (id: string) => PER_CLIENT_CHECKS.find((c) => c.id === id)!;

test("db: ok→pass, fail→fail, not_configured→fail", () => {
  assert.equal(g("db").evaluate(base()).verdict, "pass");
  assert.equal(g("db").evaluate(base({ health: health({ PostgreSQL: "fail" }) })).verdict, "fail");
  assert.equal(g("db").evaluate(base({ health: health({ PostgreSQL: "not_configured" }) })).verdict, "fail");
});

test("delinea: both ok→pass; rights not_configured→warn; either fail→fail", () => {
  assert.equal(g("delinea").evaluate(base()).verdict, "pass");
  assert.equal(g("delinea").evaluate(base({ health: health({ "Delinea rights": "not_configured" }) })).verdict, "warn");
  assert.equal(g("delinea").evaluate(base({ health: health({ Delinea: "fail" }) })).verdict, "fail");
  assert.equal(g("delinea").evaluate(base({ health: health({ "Delinea rights": "fail" }) })).verdict, "fail");
});

test("servicenow: ok→pass, not_configured→warn, fail→fail; non-blocking", () => {
  assert.equal(g("servicenow").blocking, false);
  assert.equal(g("servicenow").evaluate(base()).verdict, "pass");
  assert.equal(g("servicenow").evaluate(base({ health: health({ ServiceNow: "not_configured" }) })).verdict, "warn");
  assert.equal(g("servicenow").evaluate(base({ health: health({ ServiceNow: "fail" }) })).verdict, "fail");
});

test("azure-ai: not_configured→na, fail→warn", () => {
  assert.equal(g("azure-ai").evaluate(base({ health: health({ "Azure OpenAI": "not_configured" }) })).verdict, "na");
  assert.equal(g("azure-ai").evaluate(base({ health: health({ "Azure OpenAI": "fail" }) })).verdict, "warn");
});

test("cred-expiry: health 'fail' (imminent expiry) → warn, not fail", () => {
  assert.equal(g("cred-expiry").evaluate(base({ health: health({ "Credential expiry": "fail" }) })).verdict, "warn");
  assert.equal(g("cred-expiry").evaluate(base()).verdict, "pass");
});

test("central-runner-online: ≥1 online central→pass, 0→fail", () => {
  assert.equal(g("central-runner-online").evaluate(base()).verdict, "pass");
  // only a client agent online, no central
  assert.equal(g("central-runner-online").evaluate(base({ agents: [onlineAgent("c1", "client-1", BUILD)] })).verdict, "fail");
  // central present but offline (past the window)
  const stale: AgentSnapshot = { ...onlineAgent("central", null, BUILD), lastSeenAtMs: NOW - AGENT_ONLINE_MS - 1 };
  assert.equal(g("central-runner-online").evaluate(base({ agents: [stale] })).verdict, "fail");
});

test("runner-build-sync: all current→pass; some stale→warn; none current→fail; none online→na", () => {
  assert.equal(g("runner-build-sync").evaluate(base()).verdict, "pass");
  assert.equal(g("runner-build-sync").evaluate(base({ agents: [onlineAgent("a", null, BUILD), onlineAgent("b", "c1", "oldbuild00000")] })).verdict, "warn");
  assert.equal(g("runner-build-sync").evaluate(base({ agents: [onlineAgent("a", null, "oldbuild00000")] })).verdict, "fail");
  const offline: AgentSnapshot = { ...onlineAgent("a", null, BUILD), lastSeenAtMs: NOW - AGENT_ONLINE_MS - 1 };
  assert.equal(g("runner-build-sync").evaluate(base({ agents: [offline] })).verdict, "na");
});

test("agent-url-converged: na when no target; pass when all migrated; warn when pending; fail on error", () => {
  assert.equal(g("agent-url-converged").evaluate(base()).verdict, "na"); // no target
  const target = "https://new.example.com";
  const migrated: AgentSnapshot = { id: "m", clientId: null, lastSeenAtMs: NOW, version: BUILD, migrate: { ...emptyMigrate(), migratedAt: new Date(NOW).toISOString(), currentAppUrl: target } };
  assert.equal(g("agent-url-converged").evaluate(base({ migrationTarget: target, agents: [migrated] })).verdict, "pass");
  const pending: AgentSnapshot = { id: "p", clientId: null, lastSeenAtMs: NOW, version: BUILD, migrate: { ...emptyMigrate(), migrateRequested: true } };
  assert.equal(g("agent-url-converged").evaluate(base({ migrationTarget: target, agents: [pending] })).verdict, "warn");
  const errored: AgentSnapshot = { id: "e", clientId: null, lastSeenAtMs: NOW, version: BUILD, migrate: { ...emptyMigrate(), migrateError: "rewrite failed" } };
  assert.equal(g("agent-url-converged").evaluate(base({ migrationTarget: target, agents: [errored] })).verdict, "fail");
});

test("db-migrations: passes/warns/fails straight from the migration status verdict", () => {
  assert.equal(g("db-migrations").evaluate(base()).verdict, "pass");
  assert.equal(g("db-migrations").evaluate(base({ migrations: { verdict: "fail", expected: 3, applied: 2, missing: ["x"], rolledBack: [], detail: "" } })).verdict, "fail");
  assert.equal(g("db-migrations").evaluate(base({ migrations: { verdict: "warn", expected: 0, applied: 0, missing: [], rolledBack: [], detail: "" } })).verdict, "warn");
});

test("backups-fresh: fresh+ok→pass; stale→warn; non-blocking + cached", () => {
  assert.equal(g("backups-fresh").blocking, false);
  assert.equal(g("backups-fresh").evaluate(base()).liveness, "cached");
  assert.equal(g("backups-fresh").evaluate(base()).verdict, "pass");
  assert.equal(g("backups-fresh").evaluate(base({ backups: { ...base().backups, backupStale: true } })).verdict, "warn");
});

test("wedged-jobs: 0→pass, >0→warn", () => {
  assert.equal(g("wedged-jobs").evaluate(base()).verdict, "pass");
  assert.equal(g("wedged-jobs").evaluate(base({ wedgedJobs: 2 })).verdict, "warn");
});

// ── per-client ────────────────────────────────────────────────────────────────────────────────
function client(overrides: Partial<ClientState> = {}): ClientState {
  return { slug: "acme", name: "Acme", readinessTier: "ready", readinessSummary: "", m365: null, agentReach: null, ...overrides };
}

test("client-creds-ready: ready→pass, partial→warn, not_set_up→fail, no_systems→na", () => {
  assert.equal(pc("client-creds-ready").evaluate(base(), client({ readinessTier: "ready" })).verdict, "pass");
  assert.equal(pc("client-creds-ready").evaluate(base(), client({ readinessTier: "partial" })).verdict, "warn");
  assert.equal(pc("client-creds-ready").evaluate(base(), client({ readinessTier: "not_set_up" })).verdict, "fail");
  assert.equal(pc("client-creds-ready").evaluate(base(), client({ readinessTier: "no_systems" })).verdict, "na");
});

test("client-m365: na when no M365 system; ok→pass; over_permissioned→warn; missing_perms/no_creds/fail→fail; untested→warn", () => {
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: null })).verdict, "na");
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: { status: "ok", tags: ["completed"], missingPerms: 0 } })).verdict, "pass");
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: { status: "ok", tags: ["over_permissioned"], missingPerms: 0 } })).verdict, "warn");
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: { status: "fail", tags: ["missing_perms"], missingPerms: 3 } })).verdict, "fail");
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: { status: "untested", tags: ["no_creds"], missingPerms: 0 } })).verdict, "fail");
  assert.equal(pc("client-m365").evaluate(base(), client({ m365: { status: "untested", tags: ["untested"], missingPerms: 0 } })).verdict, "warn");
});

test("client-agent-reachable: na when cloud-only; all servable→pass; any unservable→fail; blocking", () => {
  assert.equal(pc("client-agent-reachable").blocking, true);
  assert.equal(pc("client-agent-reachable").evaluate(base(), client({ agentReach: null })).verdict, "na");
  assert.equal(pc("client-agent-reachable").evaluate(base(), client({ agentReach: { total: 2, servable: 2, reasons: [] } })).verdict, "pass");
  assert.equal(pc("client-agent-reachable").evaluate(base(), client({ agentReach: { total: 2, servable: 1, reasons: ["no agent"] } })).verdict, "fail");
});
