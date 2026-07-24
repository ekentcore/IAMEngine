import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { classifyM365Client, reapStaleM365ConnTests, rollupFleetM365Test, FLEET_M365_STALE_AFTER_MS, type ClassifyTestInput } from "./fleet-m365-test";
import { GRAPH_OPTIONAL_CAPS, suggestedRole } from "@/lib/secrets/graph-caps";

function okTest(systemKey = "m365"): ClassifyTestInput {
  // A fully-verified test: required + optional caps all ok.
  return {
    systemKey,
    status: "ok",
    accessOk: true,
    rights: [
      { op: "create / update users + assign licenses", ok: true, detail: "" },
      { op: "add users to groups", ok: true, detail: "" },
      { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
    ],
  };
}

test("no m365-admin secret -> no_creds + setup", () => {
  const r = classifyM365Client({ hasAdminSecret: false, testableSystemKeys: [], tests: [] });
  assert.equal(r.action, "setup");
  assert.ok(r.tags.includes("no_creds"));
  assert.equal(r.status, "untested");
});

test("wired credential but no test yet -> untested, action none", () => {
  const r = classifyM365Client({ hasAdminSecret: true, testableSystemKeys: ["m365"], tests: [] });
  assert.equal(r.status, "untested");
  assert.ok(r.tags.includes("untested"));
  assert.ok(!r.tags.includes("no_creds"));
  assert.equal(r.action, "none");
});

test("all ops verified -> completed + ok, no corrective action", () => {
  const r = classifyM365Client({ hasAdminSecret: true, testableSystemKeys: ["m365"], tests: [okTest()] });
  assert.equal(r.status, "ok");
  assert.ok(r.tags.includes("completed"));
  assert.equal(r.action, "none");
  assert.equal(r.missingPerms, 0);
});

test("missing required permission -> missing_perms + correct", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "fail",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: false, detail: "grant one of: User.ReadWrite.All, Directory.ReadWrite.All" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
        ],
      },
    ],
  });
  assert.equal(r.status, "fail");
  assert.ok(r.tags.includes("missing_perms"));
  assert.equal(r.action, "correct");
  assert.equal(r.missingPerms, 1);
  // A rights-explained failure is NOT a connection failure.
  assert.ok(!r.tags.includes("connection_failed"));
});

test("no usable secret + a broker-failed test -> no_creds (NOT connection_failed)", () => {
  // A client whose m365-admin has no real Delinea number: the queued test fails at the broker. That
  // must read as "No Delinea secret number", never a connection failure.
  const r = classifyM365Client({
    hasAdminSecret: false,
    testableSystemKeys: ["m365"],
    tests: [{ systemKey: "m365", status: "fail", accessOk: false, rights: null }],
  });
  assert.ok(r.tags.includes("no_creds"));
  assert.ok(!r.tags.includes("connection_failed"));
  assert.equal(r.status, "untested");
  assert.equal(r.action, "setup");
});

test("failed with no rights data -> connection_failed + setup (re-provision)", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [{ systemKey: "m365", status: "fail", accessOk: false, rights: null }],
  });
  assert.ok(r.tags.includes("connection_failed"));
  assert.ok(!r.tags.includes("missing_perms"));
  assert.equal(r.action, "setup");
});

test("surplus roles -> over_permissioned (advisory), still completed + action none", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          // surplus/escalation ride in as optional+ok=false with the OVER-PERMISSIONED prefix.
          { op: "OVER-PERMISSIONED:RoleManagement.ReadWrite.Directory", ok: false, detail: "can make itself Global Administrator", surplus: true },
        ],
      },
    ],
  });
  assert.ok(r.tags.includes("over_permissioned"));
  assert.ok(r.tags.includes("completed"));
  assert.equal(r.surplus, 1);
  assert.equal(r.escalation, 1);
  // Over-permissioning alone is not auto-correctable, so it does not force a corrective action.
  assert.equal(r.action, "none");
});

test("missing OPTIONAL cap -> pre-check its suggestedRole, but not a corrective action", () => {
  const optCap = GRAPH_OPTIONAL_CAPS[0]; // "remove MFA methods on offboard…"
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: optCap.need, ok: false, optional: true, detail: "optional — grant …" },
        ],
      },
    ],
  });
  // The optional miss maps to its narrowest role, ready to pre-check in the setup modal.
  assert.deepEqual(r.missingOptionalRoles, [suggestedRole(optCap)]);
  // An optional miss does NOT fail the test or force a correction.
  assert.ok(!r.tags.includes("missing_perms"));
  assert.equal(r.status, "ok");
  assert.equal(r.action, "none");
});

test("missing perms + surplus AppRoleAssignment.ReadWrite.All -> canSelfGrant", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "fail",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: false, detail: "grant one of: User.ReadWrite.All" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "can consent app roles to itself", surplus: true },
        ],
      },
    ],
  });
  assert.ok(r.tags.includes("missing_perms"));
  assert.ok(r.tags.includes("over_permissioned"));
  assert.equal(r.canSelfGrant, true);
});

test("holds AppRoleAssignment.ReadWrite.All + only OPTIONAL perms missing -> canSelfGrant (the Apollon case)", () => {
  const optCap = GRAPH_OPTIONAL_CAPS[0];
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok", // all REQUIRED perms are granted → healthy
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: optCap.need, ok: false, optional: true, detail: "optional — grant …" },
          { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "", surplus: true },
        ],
      },
    ],
  });
  // Required all covered, so status is healthy and there's no "missing_perms"…
  assert.equal(r.status, "ok");
  assert.ok(!r.tags.includes("missing_perms"));
  // …but an optional gap + the self-grant role means the button should still appear.
  assert.equal(r.canSelfGrant, true);
  assert.deepEqual(r.missingOptionalRoles, [suggestedRole(optCap)]);
});

test("surplus AppRoleAssignment.ReadWrite.All but NO missing perms -> canSelfGrant false", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "", surplus: true },
        ],
      },
    ],
  });
  assert.equal(r.canSelfGrant, false); // nothing to grant
});

test("m365 + entra share an app reg: surplus/escalation counted ONCE, not doubled", () => {
  // Identical rights on both systems (same app registration) — the Apollon shape: required all ok,
  // some optional missing, three escalation-capable surplus roles.
  const rights = [
    { op: "create / update users + assign licenses", ok: true, detail: "" },
    { op: "add users to groups", ok: true, detail: "" },
    { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
    { op: "OVER-PERMISSIONED:Application.ReadWrite.All", ok: false, detail: "", surplus: true },
    { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "", surplus: true },
    { op: "OVER-PERMISSIONED:DelegatedPermissionGrant.ReadWrite.All", ok: false, detail: "", surplus: true },
  ];
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365", "entra"],
    tests: [
      { systemKey: "m365", status: "ok", accessOk: true, rights },
      { systemKey: "entra", status: "ok", accessOk: true, rights: JSON.parse(JSON.stringify(rights)) },
    ],
  });
  // THREE surplus roles, all escalation — not six.
  assert.equal(r.surplus, 3);
  assert.equal(r.escalation, 3);
  assert.ok(r.tags.includes("over_permissioned"));
});

test("self_correctable tag mirrors canSelfGrant (holds the role + something to grant)", () => {
  const optCap = GRAPH_OPTIONAL_CAPS[0];
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: optCap.need, ok: false, optional: true, detail: "" },
          { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "", surplus: true },
        ],
      },
    ],
  });
  assert.equal(r.canSelfGrant, true);
  assert.ok(r.tags.includes("self_correctable"));
});

test("holds the self-grant role but fully covered -> not self_correctable", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [
      {
        systemKey: "m365",
        status: "ok",
        accessOk: true,
        rights: [
          { op: "create / update users + assign licenses", ok: true, detail: "" },
          { op: "add users to groups", ok: true, detail: "" },
          { op: "read licenses / groups (SKUs)", ok: true, detail: "" },
          { op: "OVER-PERMISSIONED:AppRoleAssignment.ReadWrite.All", ok: false, detail: "", surplus: true },
        ],
      },
    ],
  });
  assert.equal(r.canSelfGrant, false);
  assert.ok(!r.tags.includes("self_correctable"));
});

test("worst-of across systems: one entra fail makes the client fail", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365", "entra"],
    tests: [
      okTest("m365"),
      { systemKey: "entra", status: "fail", accessOk: false, rights: null },
    ],
  });
  assert.equal(r.status, "fail");
  assert.ok(r.tags.includes("connection_failed"));
  // A mixed pass/fail is not "completed".
  assert.ok(!r.tags.includes("completed"));
});

test("pending test -> running status, no premature completed", () => {
  const r = classifyM365Client({
    hasAdminSecret: true,
    testableSystemKeys: ["m365"],
    tests: [{ systemKey: "m365", status: "pending", accessOk: null, rights: null }],
  });
  assert.equal(r.status, "running");
  assert.ok(!r.tags.includes("completed"));
});

// FR#26: a client flagged noRunner (e.g. Dianthus — no agent will ever serve it) must never be
// swept, or its queued tests just sit pending forever. loadTargets is the ONE shared enumeration
// behind start/retest/rollup, so asserting its `where` clause here covers all three.
test("fleet sweep excludes noRunner clients", async () => {
  const rows = [
    {
      id: "c1", slug: "a", name: "A", coreId: "1", primaryDomain: "a.com",
      systems: [{ systemKey: "m365", mode: "api", secretNames: [], config: null }],
      secrets: [],
    },
  ];
  let captured: unknown;
  const fakeDb = {
    client: { findMany: async (args: unknown) => { captured = args; return rows; } },
    connectionTest: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    fleetM365TestRun: { findFirst: async () => null },
  } as unknown as PrismaClient;
  await rollupFleetM365Test(fakeDb, null);
  assert.equal((captured as { where: { noRunner: boolean } }).where.noRunner, false);
});

// The core fix for stuck "testing…": a pending test no runner ever claimed, or a running test whose
// agent died, is reaped once it's older than the staleness window — the client then settles from the
// tests that DID run (e.g. Agostino/Aurion: m365 + entra passed, the on-prem exchange test hung).
test("reaper deletes only stale M365 pending/running tests, leaving fresh ones", async () => {
  let captured: { where: unknown } | undefined;
  const fakeDb = {
    connectionTest: {
      deleteMany: async (args: { where: unknown }) => { captured = args; return { count: 2 }; },
    },
  } as unknown as PrismaClient;

  const reaped = await reapStaleM365ConnTests(fakeDb);
  assert.equal(reaped, 2);

  const where = captured!.where as {
    systemKey: { in: string[] };
    OR: [{ status: string; requestedAt: { lt: Date } }, { status: string; claimedAt: { lt: Date } }];
  };
  // Only the M365 family — never AD/other systems that other pages own.
  assert.deepEqual(where.systemKey.in, ["m365", "entra", "exchange"]);
  // Pending is aged by requestedAt (never claimed), running by claimedAt (claimed, never reported).
  assert.equal(where.OR[0].status, "pending");
  assert.equal(where.OR[1].status, "running");
  // The cutoff is the staleness window in the past — a just-started test is younger and survives.
  const cutoff = where.OR[0].requestedAt.lt.getTime();
  const now = Date.now();
  assert.ok(cutoff <= now - FLEET_M365_STALE_AFTER_MS + 2000, "cutoff is ~staleness window in the past");
  assert.ok(cutoff > now - FLEET_M365_STALE_AFTER_MS - 5000, "cutoff is not wildly old");
});

// The roll-up must reap on every poll — that's what makes a stuck client self-heal on page load.
test("rollup reaps stale tests before classifying", async () => {
  let reapCalled = false;
  const fakeDb = {
    client: { findMany: async () => [] },
    connectionTest: {
      findMany: async () => [],
      deleteMany: async () => { reapCalled = true; return { count: 1 }; },
    },
    fleetM365TestRun: { findFirst: async () => null },
  } as unknown as PrismaClient;
  await rollupFleetM365Test(fakeDb, null);
  assert.ok(reapCalled, "rollupFleetM365Test called the reaper");
});
