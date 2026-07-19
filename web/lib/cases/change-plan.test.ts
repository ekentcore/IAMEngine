import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMoverDiff, deltasToDiff, planChangeJobs, targetGroupsForPersona } from "./change-plan";

const dirs = ["active-directory", "m365"];

test("mover scoped: adds target groups, removes managed-but-not-target, keeps unmanaged", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales", "AllStaff"] },
    fromManagedGroupsBySystem: { "active-directory": ["Support", "AllStaff"] },
    removalMode: "scoped",
  });
  assert.deepEqual(ad.add.sort(), ["AllStaff", "Sales"]);
  assert.deepEqual(ad.removeGroups, ["Support"]); // managed by old role, not in new role
  assert.equal(ad.reconcileGroups, false);
});

test("mover scoped: never removes a protected group even if managed", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": [] },
    fromManagedGroupsBySystem: { "active-directory": ["Domain Admins", "Support"] },
    removalMode: "scoped",
  });
  assert.deepEqual(ad.removeGroups, ["Support"]); // Domain Admins excluded
});

test("mover full: sets reconcile + desired keep-list, no explicit removeGroups", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales"] },
    fromManagedGroupsBySystem: { "active-directory": ["Support"] },
    removalMode: "full",
  });
  assert.equal(ad.reconcileGroups, true);
  assert.deepEqual(ad.desiredGroups, ["Sales"]);
  assert.deepEqual(ad.removeGroups, []);
});

test("mover add-only: no removals at all", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales"] },
    fromManagedGroupsBySystem: { "active-directory": ["Support"] },
    removalMode: "add-only",
  });
  assert.deepEqual(ad.add, ["Sales"]);
  assert.deepEqual(ad.removeGroups, []);
  assert.equal(ad.reconcileGroups, false);
});

test("mover: OU move flows to AD only", () => {
  const diffs = computeMoverDiff({
    directorySystems: dirs,
    targetGroupsBySystem: {},
    fromManagedGroupsBySystem: {},
    targetOuBySystem: { "active-directory": "OU=Sales,DC=x,DC=com" },
    removalMode: "scoped",
  });
  assert.equal(diffs.find((d) => d.systemKey === "active-directory")!.moveToOu, "OU=Sales,DC=x,DC=com");
  assert.equal(diffs.find((d) => d.systemKey === "m365")!.moveToOu, undefined);
});

test("adhoc: group add/remove route to every directory; dl routes to exchange", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "group", value: "Sales" },
      { op: "remove", target: "group", value: "Support" },
      { op: "add", target: "dl", value: "sales@x.com" },
    ],
    ["active-directory", "m365", "exchange"]
  );
  const ad = diffs.find((d) => d.systemKey === "active-directory")!;
  assert.deepEqual(ad.add, ["Sales"]);
  assert.deepEqual(ad.removeGroups, ["Support"]);
  const exo = diffs.find((d) => d.systemKey === "exchange")!;
  assert.deepEqual(exo.namedGroups, ["sales@x.com"]);
});

test("adhoc: system-scoped delta lands only on that system", () => {
  const diffs = deltasToDiff([{ op: "add", target: "group", value: "Sales", system: "m365" }], ["active-directory", "m365"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "m365")!.add, ["Sales"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, []);
});

test("adhoc: protected group is dropped from adds and removes", () => {
  const diffs = deltasToDiff(
    [{ op: "add", target: "group", value: "Enterprise Admins" }, { op: "remove", target: "group", value: "Schema Admins" }],
    ["active-directory"]
  );
  assert.deepEqual(diffs[0].add, []);
  assert.deepEqual(diffs[0].removeGroups, []);
});

test("adhoc: unscoped group delta never leaks into exchange; dl still lands on exchange.namedGroups", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "group", value: "Sales" },
      { op: "add", target: "dl", value: "sales@x.com" },
    ],
    ["active-directory", "m365", "exchange"]
  );
  const exo = diffs.find((d) => d.systemKey === "exchange")!;
  assert.deepEqual(exo.add, []);
  assert.deepEqual(exo.namedGroups, ["sales@x.com"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, ["Sales"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "m365")!.add, ["Sales"]);
});

test("adhoc: group delta explicitly scoped to exchange is ignored", () => {
  const diffs = deltasToDiff(
    [{ op: "add", target: "group", value: "Sales", system: "exchange" }],
    ["active-directory", "exchange"]
  );
  assert.deepEqual(diffs.find((d) => d.systemKey === "exchange")!.add, []);
});

test("adhoc: case-variant shared mailbox adds and license removes are deduped", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "sharedMailbox", value: "team@x.com" },
      { op: "add", target: "sharedMailbox", value: "TEAM@x.com" },
      { op: "remove", target: "license", value: "E3" },
      { op: "remove", target: "license", value: "e3" },
    ],
    ["active-directory", "m365", "exchange"]
  );
  assert.deepEqual(diffs.find((d) => d.systemKey === "exchange")!.addSharedMailboxes, ["team@x.com"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "m365")!.removeLicenses, ["E3"]);
});

test("adhoc: attribute value is trimmed after the '='", () => {
  const diffs = deltasToDiff(
    [{ op: "add", target: "attribute", value: "department =  IT Ops " }],
    ["active-directory"]
  );
  assert.deepEqual(diffs[0].attributes, { department: "IT Ops" });
});

test("adhoc: remove-ou is a no-op, add-ou sets moveToOu", () => {
  const diffs = deltasToDiff(
    [{ op: "remove", target: "ou", value: "OU=x,DC=y" }],
    ["active-directory"]
  );
  assert.equal(diffs[0].moveToOu, undefined);

  const diffs2 = deltasToDiff(
    [{ op: "add", target: "ou", value: "OU=x,DC=y" }],
    ["active-directory"]
  );
  assert.equal(diffs2[0].moveToOu, "OU=x,DC=y");
});

test("adhoc: license add routes to m365.licenses, remove routes to m365.removeLicenses", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "license", value: "E3" },
      { op: "remove", target: "license", value: "E1" },
    ],
    ["active-directory", "m365"]
  );
  const m = diffs.find((d) => d.systemKey === "m365")!;
  assert.deepEqual(m.licenses, ["E3"]);
  assert.deepEqual(m.removeLicenses, ["E1"]);
});

test("adhoc: sharedMailbox add/remove route to exchange.addSharedMailboxes/removeSharedMailboxes", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "sharedMailbox", value: "billing@x.com" },
      { op: "remove", target: "sharedMailbox", value: "old@x.com" },
    ],
    ["active-directory", "exchange"]
  );
  const exo = diffs.find((d) => d.systemKey === "exchange")!;
  assert.deepEqual(exo.addSharedMailboxes, ["billing@x.com"]);
  assert.deepEqual(exo.removeSharedMailboxes, ["old@x.com"]);
});

const client = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
    { systemKey: "directory-sync", mode: "api", secretNames: [], requiresApproval: false },
  ],
};

test("planChangeJobs: one job per directory with changes; config carries the contract", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: ["Support"], reconcileGroups: false, desiredGroups: ["Sales"] },
    { systemKey: "m365", add: [], removeGroups: [], reconcileGroups: false, desiredGroups: [] },
  ]);
  const ad = jobs.find((j) => j.systemKey === "active-directory")!;
  assert.equal((ad.config as { groups: string[] }).groups[0], "Sales");
  assert.equal((ad.config as { removeGroups: string[] }).removeGroups[0], "Support");
  // an empty diff (m365 here) produces no job
  assert.equal(jobs.some((j) => j.systemKey === "m365"), false);
});

test("planChangeJobs: a removal job is approval-gated (destructive)", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: [], removeGroups: ["Support"], reconcileGroups: false, desiredGroups: [] },
  ]);
  const ad = jobs.find((j) => j.systemKey === "active-directory")!;
  assert.equal(ad.requiresApproval, true);
  assert.equal(ad.intent, "destructive");
});

test("planChangeJobs: an add-only job is not approval-gated", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "active-directory")!.requiresApproval, false);
});

test("planChangeJobs: injects directory-sync after AD when the client has it, and a trailing case-resolution", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  const keys = jobs.map((j) => j.systemKey);
  assert.ok(keys.includes("directory-sync"));
  assert.equal(keys[keys.length - 1], "case-resolution");
  assert.deepEqual(jobs.find((j) => j.systemKey === "directory-sync")!.dependsOn, ["active-directory"]);
});

test("planChangeJobs: an additive (non-removal) job carries intent null, not 'disable'", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "active-directory")!.intent, null);
});

test("planChangeJobs: a removal job still carries intent 'destructive'", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: [], removeGroups: ["Support"], reconcileGroups: false, desiredGroups: [] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "active-directory")!.intent, "destructive");
});

test("planChangeJobs: an additive job is still approval-gated when the system flags requiresApproval", () => {
  const gatedClient = {
    systems: [
      { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: true },
      { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
    ],
  };
  const jobs = planChangeJobs(gatedClient as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "active-directory")!.requiresApproval, true);
});

test("planChangeJobs: an additive job on a non-gated system is still not approval-gated", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "m365", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "m365")!.requiresApproval, false);
});

// ── targetGroupsForPersona ────────────────────────────────────────────────────────────────────
// Persona selection in lib/profiles/context.ts (buildPlanContext -> selectPersona) reads the
// persona name from payload.role (falling back to payload.roles[0] / payload.department) — NOT
// payload.persona. Model shape follows plan-resolve.test.ts's persona client (systems keyed by
// systemKey, each a { groups } fragment resolved through resolveSystemConfig).
const personaClient: import("./change-plan").ChangePlanClient = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
  ],
  personas: {
    Sales: {
      systems: {
        "active-directory": { groups: ["Sales-AD"] },
        m365: { groups: ["Sales-365"] },
      },
    },
  },
  globals: null,
  locations: null,
};

test("targetGroupsForPersona: selects the named persona by role and returns its groups per directory system", () => {
  const { groups } = targetGroupsForPersona(personaClient, "Sales");
  assert.deepEqual(groups["active-directory"], ["Sales-AD"]);
  assert.deepEqual(groups["m365"], ["Sales-365"]);
});

// ── regression: scoped removal must be per-directory-system, never a cross-system union ─────────
// Before the fix, computeMoverDiff took a flat fromManagedGroups[] union across ALL directory
// systems and subtracted it from EACH system's target. A system where the target persona grants
// no groups (e.g. m365 for an AD-only persona) then had its scoped removal become the ENTIRE
// cross-system union — including groups that live on a different system entirely and that the
// target persona actually keeps. This locks the fix: each system's removal must only ever
// consider what the FROM persona granted ON THAT SYSTEM.
test("mover scoped: removal is per-system, never a cross-system union (regression)", () => {
  const diffs = computeMoverDiff({
    directorySystems: ["active-directory", "m365"],
    targetGroupsBySystem: { "active-directory": ["A"] }, // m365 empty: target persona grants nothing there
    fromManagedGroupsBySystem: { "active-directory": ["A", "B"], m365: ["C"] },
    removalMode: "scoped",
  });
  const ad = diffs.find((d) => d.systemKey === "active-directory")!;
  const m365 = diffs.find((d) => d.systemKey === "m365")!;
  assert.deepEqual(ad.add, ["A"]);
  assert.deepEqual(ad.removeGroups, ["B"]); // A kept (in target), B removed (managed, not target)
  assert.deepEqual(m365.add, []);
  // The bug would have produced ["A", "B", "C"] here (the flat union minus m365's empty target).
  // m365 must only ever see what the FROM persona granted on m365: just "C".
  assert.deepEqual(m365.removeGroups, ["C"]);
});
