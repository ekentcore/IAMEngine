import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_REQUIRED_CAPS,
  GRAPH_OPTIONAL_CAPS,
  GRAPH_ESCALATION_ROLES,
  GRAPH_WATCHED_ROLES,
  graphCapGaps,
  graphCapRows,
  graphSurplusRoles,
  watchedRolesHeld,
  suggestedRole,
  GRAPH_APP_ROLE_IDS,
  optionalCapChoices,
  roleNamesForOptionalSelection,
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

test("the permissions we hand out instructions for carry their app-role ids", () => {
  // Without an id the non-interactive grant can't be scripted, only clicked.
  for (const r of [
    "UserAuthenticationMethod.ReadWrite.All",
    "Domain.Read.All",
    "MailboxSettings.Read",
    "User-PasswordProfile.ReadWrite.All",
  ]) {
    assert.match(GRAPH_APP_ROLE_IDS[r] ?? "", /^[0-9a-f-]{36}$/, `${r} needs an app-role id`);
  }
});

// Every id here is an APPLICATION role id read back from Microsoft's Graph service principal
// (appId 00000003-...). Microsoft publishes the same NAME as both an app role and a delegated scope
// with different ids, and consenting a delegated id to an app-only credential grants nothing while
// looking granted. Domain.Read.All shipped as 7e05723c-… — the app role for Domain.ReadWrite.All —
// so the instructions asked admins for domain WRITE to satisfy a read-only capability. Pin the exact
// values: a wrong id here is invisible until a tenant grants it and the call still returns 403.
test("app-role ids are the APPLICATION ids, not delegated scopes or a neighbouring role", () => {
  // Verify against Microsoft with: npx tsx scripts/verify-graph-role-ids.ts
  assert.deepEqual(GRAPH_APP_ROLE_IDS, {
    "UserAuthenticationMethod.ReadWrite.All": "50483e42-d915-4231-9639-7fdb7fd190e5",
    "Domain.Read.All": "dbb9058a-0e50-45d7-ae91-66909b5d4664",
    "MailboxSettings.Read": "40f97065-369a-49f4-947c-6a255697ae91",
    "User-PasswordProfile.ReadWrite.All": "cc117bb9-00cf-4eb8-b580-ea2a878fe8f7",
    "Application.Read.All": "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30",
    "Mail.Send": "b633e1c5-b582-4048-a93e-9f11b44c7e96",
    "Device.ReadWrite.All": "1138cb37-bd11-4084-a2b7-9f71582aeddb",
    "Files.ReadWrite.All": "75359482-378d-4052-8f01-80520e7db3cd",
  });
  // The delegated twins of roles we hand out — never let one of these creep back in. Each grants
  // nothing to an app-only credential while looking perfectly consented.
  const delegated = [
    "56760768-b641-451f-8906-e1b8ab31bca7", // User-PasswordProfile.ReadWrite.All (delegated)
    "2f9ee017-59c1-4f1d-9472-bd5529a7b311", // Domain.Read.All (delegated)
    "e383f46e-2787-4529-855e-0e479a3ffac0", // Mail.Send (delegated)
    "c79f8feb-a9db-4090-85f9-90d820caa0eb", // Application.Read.All (delegated)
    "87f447af-9fa4-4c32-9dfa-4a57a73d18ce", // MailboxSettings.Read (delegated)
    "b7887744-6746-4312-813d-72daeaee7e2d", // UserAuthenticationMethod.ReadWrite.All (delegated)
  ];
  assert.ok(!Object.values(GRAPH_APP_ROLE_IDS).some((id) => delegated.includes(id)));
  // Domain.Read.All's original value was Domain.ReadWrite.All's app role — a WRITE role handed out to
  // satisfy a read. Not a delegated twin, so the check above would not catch it.
  assert.notEqual(GRAPH_APP_ROLE_IDS["Domain.Read.All"], "7e05723c-0bb0-42da-be95-ae9f08a6e53c");
});

// The list on /help/cloud-auth is RENDERED from these caps, so anything we hand out instructions for
// must carry an id — otherwise the page names a role the admin can only grant by clicking.
test("every optional cap's suggested role has an app-role id to script the grant with", () => {
  for (const cap of GRAPH_OPTIONAL_CAPS) {
    assert.match(GRAPH_APP_ROLE_IDS[suggestedRole(cap)] ?? "", /^[0-9a-f-]{36}$/, `${suggestedRole(cap)} needs an app-role id`);
  }
});

// The reset is the one optional cap that does NOT degrade: without it the step fails outright. It is
// optional only because a client who never resets a cloud password is unaffected.
test("resetting a password is its own capability — User.ReadWrite.All does not cover it", () => {
  const reset = GRAPH_OPTIONAL_CAPS.find((c) => c.need.includes("reset"))!;
  assert.deepEqual(reset.anyOf, ["User-PasswordProfile.ReadWrite.All"]);
  // A tenant with the broad write roles still cannot change a password.
  const rows = graphCapRows(["Directory.ReadWrite.All", "User.ReadWrite.All"]);
  assert.equal(rows.find((r) => r.need.includes("reset"))!.ok, false);
});

// ── Over-permissioning ───────────────────────────────────────────────────────────────────────────
// The capability table only ever asked "can it do the job?". These pin the opposite question, which
// no check asked before: what authority is this credential holding that we never needed? Every case
// below is a real fleet credential as of 2026-07-16.

test("a least-privilege tenant is reported as holding nothing surplus", () => {
  assert.deepEqual(graphSurplusRoles([...NARROW, "Exchange.ManageAsApp"]), []);
});

test("an escalation role is surplus and flagged, however the rest of the grant looks", () => {
  // core31: cannot create a user (no User.ReadWrite.All) yet can make itself Global Administrator.
  const s = graphSurplusRoles(["Application.ReadWrite.All", "Exchange.ManageAsApp", "RoleManagement.ReadWrite.Directory"]);
  assert.deepEqual(s.map((r) => r.role), ["Application.ReadWrite.All", "RoleManagement.ReadWrite.Directory"]);
  assert.ok(s.every((r) => r.escalation));
  assert.match(s.find((r) => r.role === "RoleManagement.ReadWrite.Directory")!.why, /Global Administrator/);
  // Under-permissioned at the same time — the two questions are independent.
  assert.equal(graphCapGaps(["Application.ReadWrite.All", "RoleManagement.ReadWrite.Directory"]).length, 3);
});

test("escalation roles sort first — a security review must not have to scroll", () => {
  const s = graphSurplusRoles([...NARROW, "Sites.Read.All", "RoleManagement.ReadWrite.Directory", "Files.Read.All"]);
  assert.equal(s[0].role, "RoleManagement.ReadWrite.Directory");
  assert.ok(s[0].escalation);
  assert.ok(s.slice(1).every((r) => !r.escalation));
});

test("the broad role is surplus when a narrower granted one already covers the need — not both", () => {
  // Holding Group.ReadWrite.All AND GroupMember.ReadWrite.All: exactly one is redundant, and it must
  // be the one the anyOf order does NOT prefer. Flagging both would tell someone to remove the
  // permission the engine runs on. (coretelligent holds both today.)
  const s = graphSurplusRoles([...NARROW, "GroupMember.ReadWrite.All"]);
  assert.deepEqual(s.map((r) => r.role), ["GroupMember.ReadWrite.All"]);
  assert.match(s[0].why, /redundant — Group\.ReadWrite\.All is also granted/);
  // ...and alone, the same role is load-bearing and must not be reported.
  assert.ok(!graphSurplusRoles(["User.ReadWrite.All", "GroupMember.ReadWrite.All", "Organization.Read.All"]).length);
});

test("a broad role is NOT surplus while it is the only thing covering some capability", () => {
  // Non-obvious, and the reason this cannot just diff granted-against-suggested. Alongside the narrow
  // three, Directory.ReadWrite.All is the only granted role satisfying the domain-read, secret-expiry
  // AND device-disable caps — genuinely load-bearing, and calling it surplus would be advice that
  // silently breaks three features. It stays load-bearing until something narrower covers every one
  // of them; only then does it become redundant. Being wrong in this direction is the expensive one:
  // a client's security team acts on this list.
  assert.deepEqual(graphSurplusRoles([...NARROW, "Directory.ReadWrite.All"]), []);
  assert.deepEqual(graphSurplusRoles([...NARROW, "Domain.Read.All", "Directory.ReadWrite.All"]), []);
  assert.deepEqual(graphSurplusRoles([...NARROW, "Domain.Read.All", "Application.Read.All", "Directory.ReadWrite.All"]), []);
  // Every cap it covered now has a narrower granted role — NOW it is surplus.
  const fully = graphSurplusRoles([...NARROW, "Domain.Read.All", "Application.Read.All", "Device.ReadWrite.All", "Directory.ReadWrite.All"]);
  assert.deepEqual(fully.map((r) => r.role), ["Directory.ReadWrite.All"]);
  assert.match(fully[0].why, /redundant — User\.ReadWrite\.All is also granted/);
});

test("a role nothing in the engine calls is surplus, and says so plainly", () => {
  const s = graphSurplusRoles([...NARROW, "Files.Read.All"]);
  assert.deepEqual(s.map((r) => r.role), ["Files.Read.All"]);
  assert.equal(s[0].escalation, false);
  assert.match(s[0].why, /never calls anything that needs this/);
});

test("Exchange.ManageAsApp is used, not surplus — it is simply not a Graph role", () => {
  assert.deepEqual(graphSurplusRoles([...NARROW, "Exchange.ManageAsApp"]), []);
  // Its variants are NOT whitelisted: we don't call them, and a client's team should hear that.
  assert.deepEqual(graphSurplusRoles([...NARROW, "Exchange.ManageAsAppV2"]).map((r) => r.role), ["Exchange.ManageAsAppV2"]);
});

// Sites.FullControl.All must stay an escalation role, even though the SAME NAME is also the
// SharePoint-resource app role the offboard PnP site-collection-admin hand-off genuinely needs (Graph
// can't make a user a site-collection admin). The caps model matches granted roles by NAME only — it
// has no notion of which API resource (Graph vs SharePoint Online) issued a grant — so there is no way
// to tell "SharePoint's Sites.FullControl.All" apart from Microsoft Graph's own app role of the same
// name, which grants full control of every SharePoint site in the tenant via Graph: a genuine
// escalation. A prior change moved this into USED_NON_GRAPH_ROLES to silence the (correct, SharePoint
// hand-off) false positive; that made a real Graph-resource Sites.FullControl.All grant invisible to
// the surplus scan too. Keeping it in GRAPH_ESCALATION_ROLES is the safe default: clients using the
// SharePoint hand-off see a known false positive (documented in web/app/help/cloud-auth) instead of a
// genuine escalation going unflagged fleet-wide.
test("Sites.FullControl.All is treated as escalation (name-only model can't tell it apart from the Graph-resource grant)", () => {
  assert.ok(GRAPH_ESCALATION_ROLES["Sites.FullControl.All"], "Sites.FullControl.All must be listed as an escalation role");
  const s = graphSurplusRoles([...NARROW, "Sites.FullControl.All"]);
  assert.deepEqual(s.map((r) => r.role), ["Sites.FullControl.All"]);
  assert.ok(s[0].escalation, "must be reported as escalation, not as a used/redundant role");
});

test("holding an optional permission is not surplus — it is the feature working as intended", () => {
  assert.deepEqual(graphSurplusRoles([...NARROW, "User-PasswordProfile.ReadWrite.All", "Mail.Send"]), []);
});

test("the escalation list names the two roles our own setup guide promises we do not hold", () => {
  // /help/cloud-auth: "the app registration cannot grant itself new permissions (that would need
  // Application.ReadWrite.All + AppRoleAssignment.ReadWrite.All, which we deliberately do not hold)".
  // Five fleet credentials hold the first and two hold both — the check exists to surface that drift.
  for (const r of ["Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"]) {
    assert.ok(GRAPH_ESCALATION_ROLES[r], `${r} must be treated as escalation`);
  }
  assert.ok(graphSurplusRoles(["AppRoleAssignment.ReadWrite.All"])[0].escalation);
});

test("Application.Read.All is WATCHED, not escalation — and stays out of surplus", () => {
  // The Extra-access sweep surfaces who holds it (watchedRolesHeld), but it satisfies the
  // secret-expiry optional cap, so graphSurplusRoles must never report it as surplus/escalation.
  assert.ok(GRAPH_WATCHED_ROLES["Application.Read.All"], "must be a watched role");
  assert.ok(!GRAPH_ESCALATION_ROLES["Application.Read.All"], "must NOT be an escalation role");
  const held = watchedRolesHeld([...NARROW, "application.read.all"]); // case-insensitive match
  assert.deepEqual(held.map((r) => r.role), ["Application.Read.All"]);
  assert.equal(held[0].escalation, false);
  // The invariant that makes the watched/escalation split necessary: it is a used, needed role.
  assert.ok(graphSurplusRoles([...NARROW, "Application.Read.All"]).every((r) => r.role !== "Application.Read.All"));
});

test("a tenant holding no watched role reports none", () => {
  assert.deepEqual(watchedRolesHeld(NARROW), []);
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
    ["Domain.Read.All", "Domain.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"],
    // Web-only for now: the scanner needs it; the runner has no use for it yet.
    ["MailboxSettings.Read", "MailboxSettings.ReadWrite"],
    ["User-PasswordProfile.ReadWrite.All"],
    ["Application.Read.All", "Application.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"],
    ["Mail.Send"],
    ["Device.ReadWrite.All", "Directory.ReadWrite.All"],
    ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
  ]);
});

// Each cap must map to something the code actually CALLS. Every gap found on 2026-07-16 was a feature
// that shipped without anyone adding its permission here — so the list is only trustworthy if it is
// checked against the executors, not curated from memory. Names the call sites so the next reader can
// re-check them rather than trust this comment.
test("the optional caps cover every feature-gated Graph call the runner makes", () => {
  const needs = GRAPH_OPTIONAL_CAPS.map((c) => c.need).join(" | ");
  for (const feature of [
    /MFA methods/, //            Remove-MgUserAuthentication*Method   Coretelligent.M365.psm1:1206-1224
    /Temporary Access Pass/, //  New-MgUserAuthenticationTemporaryAccessPassMethod  :1846
    /verified email domains/, // GET /domains                          web/lib/m365/tenant-domains.ts:36
    /converted to shared/, //    mailboxSettings read                  leaked-seat scan
    /reset a cloud user's password/, // Update-MgUser -PasswordProfile :1892
    /secret\/certificate expires/, //   GET /applications              :1925
    /notification email/, //     Send-MgUserMail                       Coretelligent.Notify.psm1:54
    /Entra-joined devices/, //   Update-MgDevice -AccountEnabled       :1394
    /OneDrive.*delegate|delegate.*OneDrive/, // offboard OneDrive delegate hand-off
  ]) {
    assert.match(needs, feature, `no optional cap covers ${feature} — a feature that can fail for want of a permission nobody asked for`);
  }
});

test("optionalCapChoices: one choice per optional cap, keyed by its suggested role, with the need label", () => {
  const choices = optionalCapChoices();
  assert.equal(choices.length, GRAPH_OPTIONAL_CAPS.length);
  for (let i = 0; i < GRAPH_OPTIONAL_CAPS.length; i++) {
    assert.equal(choices[i].role, suggestedRole(GRAPH_OPTIONAL_CAPS[i]));
    assert.equal(choices[i].need, GRAPH_OPTIONAL_CAPS[i].need);
  }
  // Every choice role is a real optional suggested role — never a required one leaking in.
  const required = new Set(GRAPH_REQUIRED_CAPS.map((c) => suggestedRole(c)));
  for (const c of choices) assert.ok(!required.has(c.role), `${c.role} is a required role, must not be an optional choice`);
});

test("roleNamesForOptionalSelection: always includes every required role, plus exactly the chosen optional ones", () => {
  const required = GRAPH_REQUIRED_CAPS.map((c) => suggestedRole(c));
  // Empty selection = required only.
  const none = roleNamesForOptionalSelection([]);
  assert.deepEqual([...none].sort(), [...new Set(required)].sort());
  // A single optional pick shows up alongside the required set.
  const pick = suggestedRole(GRAPH_OPTIONAL_CAPS[0]);
  const one = roleNamesForOptionalSelection([pick]);
  assert.ok(one.includes(pick));
  for (const r of required) assert.ok(one.includes(r));
});

test("roleNamesForOptionalSelection: ignores unknown/garbage selections (can't smuggle in an unrequested role)", () => {
  const required = new Set(GRAPH_REQUIRED_CAPS.map((c) => suggestedRole(c)));
  const out = roleNamesForOptionalSelection(["Directory.ReadWrite.All", "not-a-real-role", "AppRoleAssignment.ReadWrite.All"]);
  // Nothing optional was validly selected, so it collapses to required-only.
  assert.deepEqual([...out].sort(), [...required].sort());
});

test("roleNamesForOptionalSelection: is case-insensitive on the selection and dedupes", () => {
  const pick = suggestedRole(GRAPH_OPTIONAL_CAPS[0]);
  const out = roleNamesForOptionalSelection([pick.toLowerCase(), pick.toUpperCase()]);
  assert.equal(out.filter((r) => r.toLowerCase() === pick.toLowerCase()).length, 1);
});
