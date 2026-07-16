import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_REQUIRED_CAPS,
  GRAPH_OPTIONAL_CAPS,
  graphCapGaps,
  graphCapRows,
  suggestedRole,
  GRAPH_APP_ROLE_IDS,
} from "./graph-caps";

// A tenant that granted the narrow roles rather than the broad ones.
const NARROW = ["User.ReadWrite.All", "Group.ReadWrite.All", "Organization.Read.All"];

test("a fully-granted tenant has no gaps", () => {
  assert.deepEqual(graphCapGaps(NARROW), []);
});

test("a capability is satisfied by ANY of its roles, not a specific one", () => {
  // Directory.ReadWrite.All alone covers create-users AND add-to-groups; the SKU read needs its own.
  assert.deepEqual(graphCapGaps(["Directory.ReadWrite.All"]), []);
  // ...and Directory.Read.All alone covers only the read.
  const gaps = graphCapGaps(["Directory.Read.All"]).map((c) => c.need);
  assert.deepEqual(gaps, ["create / update users + assign licenses", "add users to groups"]);
});

test("role matching is case-insensitive (Graph is not consistent about casing)", () => {
  assert.deepEqual(graphCapGaps(NARROW.map((r) => r.toLowerCase())), []);
});

test("an OPTIONAL permission is never a gap — a miss is noted, never a failure", () => {
  // NARROW grants none of the optional roles.
  assert.deepEqual(graphCapGaps(NARROW), []);
  const rows = graphCapRows(NARROW);
  const optional = rows.filter((r) => r.optional);
  assert.equal(optional.length, GRAPH_OPTIONAL_CAPS.length);
  assert.ok(optional.every((r) => !r.ok), "expected every optional cap to read as missing here");
  // ...and every optional row explains the consequence, since nothing fails to force the issue.
  assert.ok(optional.every((r) => (r.why ?? "").length > 0));
});

test("graphCapRows reports required and optional together, with verdicts", () => {
  const rows = graphCapRows([...NARROW, "UserAuthenticationMethod.ReadWrite.All"]);
  assert.equal(rows.length, GRAPH_REQUIRED_CAPS.length + GRAPH_OPTIONAL_CAPS.length);
  assert.equal(rows.find((r) => r.need.includes("MFA"))!.ok, true);
  assert.equal(rows.find((r) => r.need.includes("verified email domains"))!.ok, false);
});

test("the suggested role is the least-privilege one that satisfies the capability", () => {
  // Never tell someone to grant Directory.ReadWrite.All when User.ReadWrite.All will do.
  assert.equal(suggestedRole(GRAPH_REQUIRED_CAPS[0]), "User.ReadWrite.All");
  assert.equal(suggestedRole(GRAPH_REQUIRED_CAPS[1]), "Group.ReadWrite.All");
});

test("the three permissions we hand out instructions for carry their app-role ids", () => {
  // Without an id the non-interactive grant can't be scripted, only clicked.
  for (const r of ["UserAuthenticationMethod.ReadWrite.All", "Domain.Read.All", "MailboxSettings.Read"]) {
    assert.match(GRAPH_APP_ROLE_IDS[r] ?? "", /^[0-9a-f-]{36}$/, `${r} needs an app-role id`);
  }
});

// This file is the web's copy of $GRAPH_REQUIRED_CAPS / $GRAPH_OPTIONAL_CAPS in
// runner/Start-IamRunner.ps1. The runner can't import TypeScript, so the two are hand-synced — pin the
// role names here so a drift fails a test instead of producing a fleet-wide false "permission missing".
test("the cap sets match the runner's copy (hand-synced — update both)", () => {
  assert.deepEqual(GRAPH_REQUIRED_CAPS.map((c) => c.anyOf), [
    ["User.ReadWrite.All", "Directory.ReadWrite.All"],
    ["Group.ReadWrite.All", "GroupMember.ReadWrite.All", "Directory.ReadWrite.All"],
    ["Organization.Read.All", "Directory.Read.All", "Directory.ReadWrite.All", "User.Read.All", "Group.Read.All"],
  ]);
  assert.deepEqual(GRAPH_OPTIONAL_CAPS.map((c) => c.anyOf), [
    ["UserAuthenticationMethod.ReadWrite.All"],
    ["Domain.Read.All"],
    // Web-only for now: the scanner needs it; the runner has no use for it yet.
    ["MailboxSettings.Read", "MailboxSettings.ReadWrite"],
  ]);
});
