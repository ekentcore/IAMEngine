// Fleet Setup — M365: a fleet-wide connection-test sweep over the M365-family systems, plus the
// per-client classification the tool's table renders from. The pure classifier
// (classifyM365Client) turns a client's connection-test rows + secret presence into a status, a set
// of state tags (the table's filters), a suggested corrective action, and the optional Graph roles
// to pre-check when correcting permissions. The I/O helpers start / roll up / cancel a sweep on top
// of the existing connection-test lane — ConnectionTest is the durable source of truth, so nothing
// per-client is duplicated onto the run row.
import type { PrismaClient } from "@prisma/client";
import { parseRights, summarizeRights, testableSystems, type RightsRow } from "./conn-test-logic";
import type { RunnerService } from "./runner-service";
import { ALWAYS_ON_PREM_SYSTEMS } from "@/lib/cases/case-secrets";
import { GRAPH_OPTIONAL_CAPS, suggestedRole } from "@/lib/secrets/graph-caps";
import { scopeAllows, type ClientScope } from "@/lib/auth/client-scope";

// The systems this tool covers. A client is "an M365 client" if it has any of these.
export const M365_FAMILY = ["m365", "entra", "exchange"] as const;

// The scope string for the sweep's one-running guard (see the partial unique index).
export const FLEET_M365_SCOPE = "fleet-m365";

// A running sweep older than this is treated as finished: the tests it queued are either done or
// stuck pending (no runner claimed them / an on-prem client with no agent), and either way the run
// must not freeze the page's "Testing…" button forever. Both the roll-up (auto-settle) and a new
// "Retest all" (supersede) honor it, so a stuck run always self-heals.
export const FLEET_M365_STALE_AFTER_MS = 10 * 60 * 1000; // 10 min

// The app credential every M365-family system authenticates with. Its absence is "no creds".
const M365_ADMIN_SECRET = "m365-admin";
// Delinea externalId values that mean "no real secret number" — a row exists but points at nothing
// usable, so it can't broker. Mirrors the UNSET sentinels the fleet audit skips.
const M365_ADMIN_UNSET = ["", "REPLACE_ME", "NOT_NEEDED"];

// need -> the narrowest role that satisfies that optional capability. The runner reports a rights
// row's `op` AS the capability's `need` string (runner/Start-IamRunner.ps1), and the need strings in
// graph-caps.ts mirror it exactly — so a missing optional rights row maps back to its suggestedRole
// by an exact need match, with no fragile substring parsing.
const OPTIONAL_ROLE_BY_NEED = new Map(GRAPH_OPTIONAL_CAPS.map((c) => [c.need, suggestedRole(c)]));

export type FleetM365Tag =
  | "no_creds" // no m365-admin secret / no testable M365 system — nothing to connect with
  | "missing_perms" // a test's required rights are missing
  | "over_permissioned" // a test reports surplus (roles the engine never uses)
  | "self_correctable" // holds AppRoleAssignment.ReadWrite.All AND is missing something → can self-grant
  | "connection_failed" // a test failed on access/API, not on rights
  | "completed" // every test connects and its required rights verify
  | "untested"; // has a wired credential but no result yet (sweep not run / just started)

export type FleetM365Action = "setup" | "correct" | "none";
export type FleetM365Status = "ok" | "fail" | "running" | "pending" | "unverified" | "untested";

// One M365-family connection-test row, reduced to what the classifier needs. `rights` is the RAW
// stored value — the classifier runs it through parseRights so surplus/escalation are counted.
export type ClassifyTestInput = {
  systemKey: string;
  status: "pending" | "running" | "ok" | "fail" | "not_needed";
  accessOk: boolean | null;
  rights: unknown;
};

export type ClassifyInput = {
  hasAdminSecret: boolean; // the m365-admin app credential is wired
  testableSystemKeys: string[]; // M365-family systems that are api-mode with a secret (so, testable)
  tests: ClassifyTestInput[]; // that client's M365-family connection-test rows
};

export type ClassifyResult = {
  status: FleetM365Status;
  tags: FleetM365Tag[];
  action: FleetM365Action;
  missingOptionalRoles: string[]; // to pre-check in the setup modal for a permission correction
  missingPerms: number; // total missing required ops across tests (for the badge)
  surplus: number; // total surplus roles across tests
  escalation: number; // of the surplus, how many are an escalation risk
  // The app holds AppRoleAssignment.ReadWrite.All (a flagged surplus) AND has missing permissions — so
  // the gaps can be self-granted using that role, no Global Admin sign-in. Drives "Correct permissions"
  // down the self-grant path instead of the device-code modal.
  canSelfGrant: boolean;
};

// The surplus role that lets an app assign app roles to itself — see lib/secrets/self-grant-m365.ts.
const SELF_GRANT_ROLE_LC = "approleassignment.readwrite.all";

// Pure: turn a client's connection-test state into the table's status / tags / action. No I/O.
export function classifyM365Client(input: ClassifyInput): ClassifyResult {
  const { hasAdminSecret, testableSystemKeys, tests } = input;
  const tags = new Set<FleetM365Tag>();

  // No credential to connect with: the systems exist but nothing is (or can be) tested. This is the
  // "Set up M365" case — the app registration + Delinea secret number don't exist yet. Short-circuit
  // BEFORE looking at any test rows: with no usable secret the runner can only fail at the broker, and
  // that broker failure must read as "No Delinea secret number", never "connection failed".
  const noCreds = !hasAdminSecret || testableSystemKeys.length === 0;
  if (noCreds) {
    return {
      status: "untested",
      tags: ["no_creds"],
      action: "setup",
      missingOptionalRoles: [],
      missingPerms: 0,
      surplus: 0,
      escalation: 0,
      canSelfGrant: false,
    };
  }

  const missingOptionalRoles = new Set<string>();
  let connFailed = false;

  // m365 and entra probe the SAME app registration, so they report the SAME Graph rights. Summing
  // counts per-test double-counts every surplus / missing / escalation across those two systems (a
  // client with 3 extra roles read "6"). Merge all the M365-family rights by op FIRST — exchange's one
  // EXO op is distinct and rides along untouched — then summarize once, so every count is per unique
  // permission, not per system that reported it.
  const merged = mergeRightsByOp(tests);
  const msr = summarizeRights(merged);
  const missingPerms = msr.state === "missing" ? msr.missing : 0;
  const surplus = msr.state === "unknown" ? 0 : msr.surplus;
  const escalation = msr.state === "unknown" ? 0 : msr.escalation;
  if (msr.state === "missing") tags.add("missing_perms");

  let hasSelfGrantRole = false;
  for (const r of merged) {
    collectMissingOptionalRole(r, missingOptionalRoles);
    // The self-grant primitive shows up as a flagged surplus row (over-permission).
    if (r.surplus && r.op.toLowerCase() === SELF_GRANT_ROLE_LC) hasSelfGrantRole = true;
  }

  // A failed test is a connection problem UNLESS the failure is explained by missing rights (a
  // permissions problem, handled above). A fail with no rights data at all reads as connection.
  for (const t of tests) {
    if (t.status !== "fail") continue;
    if (summarizeRights(parseRights(t.rights)).state !== "missing") connFailed = true;
  }

  if (surplus > 0) tags.add("over_permissioned");
  if (connFailed) tags.add("connection_failed");

  const hasFail = tests.some((t) => t.status === "fail");
  const hasPending = tests.some((t) => t.status === "pending" || t.status === "running");
  const settledTests = tests.filter((t) => t.status !== "not_needed");

  let status: FleetM365Status;
  if (settledTests.length === 0) status = "untested";
  else if (hasFail) status = "fail";
  else if (hasPending) status = "running";
  else {
    const anyUnverified = settledTests.some((t) => summarizeRights(parseRights(t.rights)).state === "unverified");
    status = anyUnverified ? "unverified" : "ok";
  }

  // "completed" = it works: every test connects and its required rights verify. Over-permissioning is
  // an overlay that does NOT disqualify completed (the credential still does the job), so a client can
  // be both completed and over_permissioned — each is its own filter.
  if (settledTests.length > 0 && !hasFail && !hasPending && !tags.has("missing_perms")) tags.add("completed");
  // A wired credential with no result yet (sweep hasn't run this one, or it's still queued and every
  // row is pending) is "untested" — distinct from no_creds.
  if (!noCreds && settledTests.length === 0) tags.add("untested");

  // Suggested primary action. Over-permissioning alone is NOT auto-correctable (provisioning only
  // adds/consents, never revokes), so it doesn't drive a "correct" action — it's surfaced for a
  // security review and the modal stays reachable as "Adjust".
  let action: FleetM365Action;
  if (noCreds || connFailed) action = "setup";
  else if (tags.has("missing_perms")) action = "correct";
  else action = "none";

  // Self-grant is offered when the app can grant its own roles (holds AppRoleAssignment.ReadWrite.All)
  // AND there's ANYTHING to grant — a missing REQUIRED permission or a missing OPTIONAL one. A client
  // whose required perms are all covered but that's short some optional caps (e.g. Apollon) still gets
  // the button, so the operator can top up the gaps without a Global Admin.
  const canSelfGrant = hasSelfGrantRole && (tags.has("missing_perms") || missingOptionalRoles.size > 0);
  // Its own filter so an operator can jump straight to the clients the self-grant button will act on.
  if (canSelfGrant) tags.add("self_correctable");

  return {
    status,
    tags: [...tags],
    action,
    missingOptionalRoles: [...missingOptionalRoles],
    missingPerms,
    surplus,
    escalation,
    canSelfGrant,
  };
}

// A missing optional capability's rights row -> the role to pre-check (its suggestedRole). Surplus
// rows ride in as optional+ok=false too, so exclude them: they are the opposite finding (too MANY
// permissions), never something to request.
function collectMissingOptionalRole(r: RightsRow, into: Set<string>): void {
  if (!r.optional || r.surplus || r.ok !== false) return;
  const role = OPTIONAL_ROLE_BY_NEED.get(r.op);
  if (role) into.add(role);
}

// Merge the rights rows of a client's M365-family tests into ONE row per operation. m365 and entra
// share an app registration, so they report identical Graph rights — deduping by op collapses those
// twins to one (exchange's distinct EXO op rides along unchanged), so downstream counts are per unique
// permission, not per system that reported it. When two tests disagree on an op (typically one was
// Graph-throttled to `ok:null`), the definitive verdict wins, and true beats false: on the same app
// registration a role read as granted anywhere IS granted. Flags (optional/surplus/escalation) union.
function mergeRightsByOp(tests: ClassifyTestInput[]): RightsRow[] {
  const byOp = new Map<string, RightsRow>();
  for (const t of tests) {
    if (t.status === "not_needed") continue;
    for (const r of parseRights(t.rights) ?? []) {
      const prev = byOp.get(r.op);
      if (!prev) { byOp.set(r.op, { ...r }); continue; }
      const ok = prev.ok === true || r.ok === true ? true : prev.ok === false || r.ok === false ? false : null;
      byOp.set(r.op, {
        ...prev,
        ok,
        optional: prev.optional || r.optional,
        surplus: prev.surplus || r.surplus,
        escalation: prev.escalation || r.escalation,
      });
    }
  }
  return [...byOp.values()];
}

// ── I/O: sweep orchestration on top of the connection-test lane ──────────────────────────────────

// The clients this sweep targets: non-archived, in scope, with at least one M365-family system.
export type FleetM365Target = {
  id: string;
  slug: string;
  name: string;
  coreId: string | null;
  primaryDomain: string | null;
  m365Systems: { systemKey: string; mode: string; secretNames: string[] | null; config: unknown }[];
  hasAdminSecret: boolean;
  // The client runs an on-prem AD/sync system — makes `exchange` a hybrid (on-prem) test that only the
  // client's own agent can run. Must be computed from the client's FULL system set (not the M365
  // subset), exactly as requestConnectionTests does, or a hybrid client's Exchange test is misrouted
  // to the central runner, which has no path into the on-prem environment.
  hasAd: boolean;
};

async function loadTargets(db: PrismaClient, scope: ClientScope): Promise<FleetM365Target[]> {
  const clients = await db.client.findMany({
    // noRunner: false — a client flagged as having no runner/agent at all (e.g. Dianthus) is skipped
    // entirely: a sweep would only queue tests that sit pending forever with nothing to claim them.
    where: { archivedAt: null, noRunner: false, systems: { some: { systemKey: { in: [...M365_FAMILY] } } } },
    select: {
      id: true,
      slug: true,
      name: true,
      coreId: true,
      primaryDomain: true,
      // ALL systems — so hasAd (on-prem AD/sync presence) is detected the same way the per-client
      // conn-test path does. The M365-family subset is filtered out of this in JS below.
      systems: { select: { systemKey: true, mode: true, secretNames: true, config: true } },
      secrets: { where: { name: M365_ADMIN_SECRET }, select: { externalId: true } },
    },
    orderBy: { name: "asc" },
  });
  return clients
    .filter((c) => scopeAllows(scope, c.id))
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      coreId: c.coreId,
      primaryDomain: c.primaryDomain,
      m365Systems: c.systems.filter((s) => (M365_FAMILY as readonly string[]).includes(s.systemKey)),
      // "Has a credential" means a USABLE Delinea secret number, not just a wired row: a placeholder /
      // unset externalId can't broker, so a test would fail at connect and read as "connection failed"
      // when the real state is "no Delinea secret number". Treat those as no-creds (→ Set up M365).
      hasAdminSecret: c.secrets.some((s) => !M365_ADMIN_UNSET.includes((s.externalId ?? "").trim())),
      hasAd: c.systems.some((s) => ALWAYS_ON_PREM_SYSTEMS.includes(s.systemKey)),
    }));
}

export type StartFleetArgs = { startedBy: string | null; scope: ClientScope };
export type StartFleetResult = { started: boolean; id?: string; reason?: string; clients?: number; tests?: number };

// Start a sweep: guard one-running-per-scope, resolve in-scope M365 clients, queue a connection test
// for each testable M365-family system, and record the run. The runner throttles execution via its
// claim batches, so there's no app-side batching. Never `deep` — a fleet run must not fan out
// interactive M365 sign-ins.
export async function startFleetM365Test(
  db: PrismaClient,
  svc: Pick<RunnerService, "requestConnectionTests">,
  args: StartFleetArgs
): Promise<StartFleetResult> {
  const live = await db.fleetM365TestRun.findFirst({ where: { scope: FLEET_M365_SCOPE, status: "running" }, orderBy: { startedAt: "desc" } });
  if (live) {
    // A genuinely in-progress sweep blocks a duplicate. A STALE one (its tests never settled) is
    // finished off so "Retest all" can always start a fresh sweep instead of wedging on a dead run.
    if (Date.now() - live.startedAt.getTime() <= FLEET_M365_STALE_AFTER_MS) {
      return { started: false, reason: "a fleet M365 test is already in progress", id: live.id };
    }
    await db.fleetM365TestRun.updateMany({ where: { id: live.id, status: "running" }, data: { status: "done", finishedAt: new Date() } });
  }

  const targets = await loadTargets(db, args.scope);
  let queued = 0;
  let sweptClients = 0;
  for (const t of targets) {
    const specs = testableSystems(t.m365Systems, t.hasAd);
    if (specs.length === 0) continue; // no wired credential -> nothing to test (a no_creds row)
    let any = false;
    for (const spec of specs) {
      // Per-system queue via the vetted path (delete+recreate that system's row, run the field
      // preflight). Best-effort: one client's transient failure must not abort the sweep.
      try {
        const out = await svc.requestConnectionTests(t.slug, spec.systemKey, "sweep");
        queued += out.tests.length;
        if (out.tests.length > 0) any = true;
      } catch {
        /* skip this system — the roll-up still classifies the client from whatever ran */
      }
    }
    if (any) sweptClients++;
  }

  let run;
  try {
    run = await db.fleetM365TestRun.create({
      data: { scope: FLEET_M365_SCOPE, status: "running", startedBy: args.startedBy, total: queued, clients: sweptClients },
    });
  } catch (e) {
    // Lost the create race against a concurrent caller — the partial unique index rejected us.
    const winner = await db.fleetM365TestRun.findFirst({ where: { scope: FLEET_M365_SCOPE, status: "running" }, orderBy: { startedAt: "desc" } });
    if (winner) return { started: false, reason: "a fleet M365 test is already in progress", id: winner.id };
    throw e;
  }
  return { started: true, id: run.id, clients: sweptClients, tests: queued };
}

export type RetestOneResult = { ok: boolean; reason?: string; tests?: number };

// Retest ONE client's M365-family systems (the per-row "Retest"), scope-checked. Queues via the same
// sweep-sourced path so it's picked up by the runner and reflected in the roll-up; does NOT touch the
// fleet run row (a targeted retest isn't a new sweep). Never `deep`.
export async function retestFleetM365Client(
  db: PrismaClient,
  svc: Pick<RunnerService, "requestConnectionTests">,
  slug: string,
  scope: ClientScope
): Promise<RetestOneResult> {
  const target = (await loadTargets(db, scope)).find((t) => t.slug === slug);
  // Out of scope / not an M365 client reads as not-found (mirrors clientSlugInScope semantics).
  if (!target) return { ok: false, reason: "not found" };
  const specs = testableSystems(target.m365Systems, target.hasAd);
  if (specs.length === 0) return { ok: false, reason: "this client has no wired M365 credential to test" };
  let queued = 0;
  for (const spec of specs) {
    try {
      const out = await svc.requestConnectionTests(slug, spec.systemKey, "sweep");
      queued += out.tests.length;
    } catch {
      /* skip this system — the others still run */
    }
  }
  return { ok: true, tests: queued };
}

export type FleetM365Row = {
  slug: string;
  name: string;
  coreId: string | null;
  systems: string[]; // the M365-family systems this client has
  hasAdminSecret: boolean;
} & ClassifyResult;

export type FleetM365Rollup = {
  run: { id: string; status: string; startedAt: string; finishedAt: string | null; startedBy: string | null; total: number; clients: number } | null;
  rows: FleetM365Row[];
};

// Delete M365-family connection tests that have sat pending/running past the staleness window — the
// row-level counterpart to the Job lease reclaim (runner-service.ts). A `pending` test older than the
// cutoff was never claimed (no eligible runner — e.g. a hybrid client's on-prem exchange with no
// agent); a `running` one claimed before the cutoff never reported (its agent died, and
// reportConnectionTest is agent-id-locked so nothing else can settle it). Either way it's dead: we
// clear it (not mark it failed) so the client is classified from the tests that DID run, matching the
// run-level auto-settle. Reuses FLEET_M365_STALE_AFTER_MS — "no result in 10 min" is the same cutoff.
// Scoped to M365_FAMILY so this only touches what the fleet-m365 tool owns. Returns how many it reaped.
export async function reapStaleM365ConnTests(db: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - FLEET_M365_STALE_AFTER_MS);
  const { count } = await db.connectionTest.deleteMany({
    where: {
      systemKey: { in: [...M365_FAMILY] },
      OR: [
        { status: "pending", requestedAt: { lt: cutoff } },
        { status: "running", claimedAt: { lt: cutoff } },
      ],
    },
  });
  return count;
}

// Roll up the current sweep: latest run + one classified row per in-scope M365 client. Also settles a
// running run to "done" once no target connection test is still pending/running (the sweep is
// advance-on-poll — this GET is where progress moves).
export async function rollupFleetM365Test(db: PrismaClient, scope: ClientScope): Promise<FleetM365Rollup> {
  // Reap stale M365-family tests BEFORE classifying, so a row no runner ever claimed (a hybrid
  // client's on-prem exchange/AD test with no agent, or an agent that died mid-probe) can't pin the
  // client on "testing…" forever. ConnectionTest — unlike Job — has no lease reclaim, so this poll is
  // where the recovery happens: the client then settles from whatever tests DID run.
  await reapStaleM365ConnTests(db);
  const targets = await loadTargets(db, scope);
  const clientIds = targets.map((t) => t.id);
  const tests = clientIds.length
    ? await db.connectionTest.findMany({
        where: { clientId: { in: clientIds }, systemKey: { in: [...M365_FAMILY] } },
        select: { clientId: true, systemKey: true, status: true, accessOk: true, rights: true },
      })
    : [];
  const testsByClient = new Map<string, ClassifyTestInput[]>();
  for (const t of tests) {
    const arr = testsByClient.get(t.clientId) ?? [];
    arr.push({ systemKey: t.systemKey, status: t.status as ClassifyTestInput["status"], accessOk: t.accessOk, rights: t.rights });
    testsByClient.set(t.clientId, arr);
  }

  const rows: FleetM365Row[] = targets.map((t) => {
    const clientTests = testsByClient.get(t.id) ?? [];
    const testableSystemKeys = testableSystems(t.m365Systems, t.hasAd).map((s) => s.systemKey);
    const cls = classifyM365Client({ hasAdminSecret: t.hasAdminSecret, testableSystemKeys, tests: clientTests });
    return {
      slug: t.slug,
      name: t.name,
      coreId: t.coreId,
      systems: t.m365Systems.map((s) => s.systemKey),
      hasAdminSecret: t.hasAdminSecret,
      ...cls,
    };
  });

  const run = await db.fleetM365TestRun.findFirst({ where: { scope: FLEET_M365_SCOPE }, orderBy: { startedAt: "desc" } });
  if (run && run.status === "running") {
    // Settle from the sweep's OWN unsettled tests across the whole fleet — NOT the caller's scoped
    // view. A narrower-scoped operator polling must not mark the run done while tests it can't see are
    // still running (which would let a second sweep start and delete in-flight rows). `source:"sweep"`
    // is how the sweep tags what it queued, so this ignores unrelated manual per-client retests.
    const unsettled = await db.connectionTest.count({
      where: { status: { in: ["pending", "running"] }, source: "sweep", systemKey: { in: [...M365_FAMILY] } },
    });
    // Settle when the sweep's tests are all done — OR when the run has gone stale (tests stuck pending
    // because no runner claimed them), so the page's "Testing…" button can never be frozen forever.
    const stale = Date.now() - run.startedAt.getTime() > FLEET_M365_STALE_AFTER_MS;
    if (unsettled === 0 || stale) {
      await db.fleetM365TestRun.updateMany({ where: { id: run.id, status: "running" }, data: { status: "done", finishedAt: new Date() } });
      run.status = "done";
      run.finishedAt = new Date();
    }
  }

  return {
    run: run
      ? { id: run.id, status: run.status, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null, startedBy: run.startedBy, total: run.total, clients: run.clients }
      : null,
    rows,
  };
}

export type CancelFleetResult = { cancelled: boolean; id?: string; reason?: string };

// Cancel the live sweep: flip it to "cancelled" and delete still-pending M365 connection tests so the
// runner stops claiming them. Tests already running finish naturally (there's no mid-probe abort).
export async function cancelFleetM365Test(db: PrismaClient): Promise<CancelFleetResult> {
  const live = await db.fleetM365TestRun.findFirst({ where: { scope: FLEET_M365_SCOPE, status: "running" }, orderBy: { startedAt: "desc" } });
  if (!live) return { cancelled: false, reason: "no fleet M365 test is in progress" };
  const flipped = await db.fleetM365TestRun.updateMany({ where: { id: live.id, status: "running" }, data: { status: "cancelled", finishedAt: new Date() } });
  if (flipped.count === 0) return { cancelled: false, reason: "the sweep just finished", id: live.id };
  // Delete only the sweep's OWN still-pending tests (source:"sweep") so the runner stops claiming them
  // — never an operator's unrelated manual per-client retest that happens to be pending. Running tests
  // finish naturally (there's no mid-probe abort).
  await db.connectionTest.deleteMany({ where: { status: "pending", source: "sweep", systemKey: { in: [...M365_FAMILY] } } });
  return { cancelled: true, id: live.id };
}
