import { test } from "node:test";
import assert from "node:assert/strict";
import { pivotByPermission, pivotEscalationHolders, leakVerdict, type PermissionRow, type EscalationHolderRow } from "./m365-audit";

function row(over: Partial<PermissionRow>): PermissionRow {
  return {
    clientId: "c1", client: "Client One", slug: "core1", status: "ok",
    granted: [], missingRequired: [], missingOptional: [], surplus: [],
    ...over,
  };
}

test("pivot groups clients by the permission they are missing — the question the per-client test can't answer", () => {
  const p = pivotByPermission([
    row({ slug: "a", status: "gaps", missingOptional: ["UserAuthenticationMethod.ReadWrite.All"] }),
    row({ slug: "b", status: "gaps", missingOptional: ["UserAuthenticationMethod.ReadWrite.All", "Domain.Read.All"] }),
    row({ slug: "c", status: "ok" }),
  ]);
  const mfa = p.find((x) => x.role === "UserAuthenticationMethod.ReadWrite.All")!;
  assert.deepEqual(mfa.clients.map((c) => c.slug), ["a", "b"]);
  assert.equal(mfa.optional, true);
  assert.deepEqual(p.find((x) => x.role === "Domain.Read.All")!.clients.map((c) => c.slug), ["b"]);
});

test("required permissions sort above optional ones, then by how many clients need them", () => {
  const p = pivotByPermission([
    row({ slug: "a", status: "gaps", missingOptional: ["Domain.Read.All"] }),
    row({ slug: "b", status: "gaps", missingOptional: ["Domain.Read.All"] }),
    row({ slug: "c", status: "gaps", missingOptional: ["Domain.Read.All"] }),
    row({ slug: "d", status: "gaps", missingRequired: ["User.ReadWrite.All"] }),
  ]);
  // A required gap breaks things; an optional one is a note. One client missing a required
  // permission outranks three missing an optional one.
  assert.deepEqual(p.map((x) => x.role), ["User.ReadWrite.All", "Domain.Read.All"]);
});

// Graph throttles a fleet sweep, and PR #90 is the reminder of what that costs: a dropped read once
// reported every permission as missing. An unconfirmed gap must never reach a to-do list.
test("an UNVERIFIED client never appears in the pivot, even though it has apparent gaps", () => {
  const p = pivotByPermission([
    row({ slug: "throttled", status: "unverified", missingRequired: ["User.ReadWrite.All"], missingOptional: ["Domain.Read.All"] }),
    row({ slug: "real", status: "gaps", missingRequired: ["User.ReadWrite.All"] }),
  ]);
  assert.deepEqual(p.map((x) => x.role), ["User.ReadWrite.All"]);
  assert.deepEqual(p[0].clients.map((c) => c.slug), ["real"], "a throttled read is not evidence of a gap");
});

test("a client with no gaps produces no pivot rows", () => {
  assert.deepEqual(pivotByPermission([row({ status: "ok" })]), []);
  assert.deepEqual(pivotByPermission([]), []);
});

test("a client with no usable credential is not reported as missing permissions", () => {
  // We learned nothing about it — that's the permission report's "no usable credential" line, not a gap.
  assert.deepEqual(pivotByPermission([row({ slug: "x", status: "cred-bad" }), row({ slug: "y", status: "no-cred" })]), []);
});

test("the leaked-seat verdict never suggests pulling a licence off an unconverted mailbox", () => {
  assert.match(leakVerdict("shared"), /safe to remove/i);
  assert.match(leakVerdict("not-shared"), /convert the mailbox FIRST/i);
  assert.match(leakVerdict("not-shared"), /purge/i); // says WHY, not just what
  assert.match(leakVerdict("unknown"), /MailboxSettings\.Read|before acting/i);
  // The only verdict that green-lights removal is the one where the mailbox is already shared.
  for (const m of ["not-shared", "unknown"] as const) assert.doesNotMatch(leakVerdict(m), /^safe to remove/i);
});

function eRow(over: Partial<EscalationHolderRow>): EscalationHolderRow {
  return { clientId: "c1", client: "Client One", slug: "core1", status: "ok", escalations: [], ...over };
}

test("escalation pivot groups holders by role, AppRoleAssignment.ReadWrite.All first", () => {
  const p = pivotEscalationHolders([
    eRow({ slug: "a", escalations: [{ role: "Application.ReadWrite.All", escalation: true, why: "can add creds to any app" }] }),
    eRow({ slug: "b", escalations: [
      { role: "AppRoleAssignment.ReadWrite.All", escalation: true, why: "can consent app roles to itself" },
      { role: "Application.ReadWrite.All", escalation: true, why: "can add creds to any app" },
    ] }),
    eRow({ slug: "c", escalations: [] }), // holds nothing → not a holder of any role
  ]);
  // The tenant-takeover route sorts first.
  assert.equal(p[0].role, "AppRoleAssignment.ReadWrite.All");
  assert.deepEqual(p[0].clients.map((c) => c.slug), ["b"]);
  const appRw = p.find((x) => x.role === "Application.ReadWrite.All")!;
  assert.deepEqual(appRw.clients.map((c) => c.slug).sort(), ["a", "b"]);
  assert.match(appRw.why, /add cred/i); // carries the human-readable reason
});

test("escalation pivot: no holders -> empty", () => {
  assert.deepEqual(pivotEscalationHolders([eRow({ escalations: [] })]), []);
});
