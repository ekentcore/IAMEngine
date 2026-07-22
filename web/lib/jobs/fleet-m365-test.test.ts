import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyM365Client, type ClassifyTestInput } from "./fleet-m365-test";
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
