import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalQuestion, matchChoices, normalizeGroupList, type ChoiceMapping } from "./universal-choices";
import { resolvePlannedConfigs } from "../profiles/plan-resolve";
import { applyChoiceSync } from "./universal-choices-sync";
import type { PlannedJob } from "../orchestrator";

const choice = (question: string, label: string, m365Groups: string[] = [], googleGroups: string[] = [], value = label): ChoiceMapping =>
  ({ question, label, value, m365Groups, googleGroups });
const job = (systemKey: string, config: unknown = {}): PlannedJob =>
  ({ systemKey, sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config });
const cfgOf = (jobs: PlannedJob[], key: string) => jobs.find((j) => j.systemKey === key)!.config as Record<string, unknown>;
const payload = { firstName: "Jane", lastName: "Doe", userPrincipalName: "jdoe@x.com" };

test("ServiceNow's spellings of the nine questions all resolve", () => {
  assert.equal(canonicalQuestion("Cloud Applications"), "Cloud Applications");
  assert.equal(canonicalQuestion("cloud application"), "Cloud Applications");
  assert.equal(canonicalQuestion("Security Groups"), "Security Group");
  assert.equal(canonicalQuestion("Role(s)"), "Role");
  assert.equal(canonicalQuestion("  Shared   Mailbox "), "Shared Mailbox");
  assert.equal(canonicalQuestion("Favourite colour"), null);
});

test("a pick matches its choice by Label or Value, case-insensitively, under the right question only", () => {
  const choices = [
    choice("Cloud Applications", "Adobe Acrobat", ["SG-Adobe"], ["adobe@x.com"], "adobe_acrobat"),
    choice("Installed Software", "Adobe Acrobat", ["SW-Acrobat-Deploy"]),
  ];
  const byLabel = matchChoices({ cloudApplications: ["adobe acrobat"] }, choices);
  assert.deepEqual(byLabel.m365, ["SG-Adobe"]);
  assert.deepEqual(byLabel.google, ["adobe@x.com"]);
  const byValue = matchChoices({ cloudApplications: ["ADOBE_ACROBAT"] }, choices);
  assert.deepEqual(byValue.m365, ["SG-Adobe"]);
  // The same label under Installed Software maps separately.
  assert.deepEqual(matchChoices({ installedSoftware: ["Adobe Acrobat"] }, choices).m365, ["SW-Acrobat-Deploy"]);
});

test("a choice with no groups is ignored, and groups from several picks are de-duplicated", () => {
  const choices = [
    choice("Cloud Applications", "Zoom", ["SSO - Zoom", "All Apps"]),
    choice("Cloud Applications", "Slack", ["All Apps", "SSO - Slack"]),
    choice("Cloud Applications", "Box"),
  ];
  const m = matchChoices({ cloudApplications: ["Zoom", "Slack", "Box"] }, choices);
  assert.deepEqual(m.m365, ["SSO - Zoom", "All Apps", "SSO - Slack"]);
  assert.deepEqual(m.matched.map((x) => x.label), ["Zoom", "Slack"]);
});

test("a string pick list splits on ';' when present, so a name with a comma survives (FR #174)", () => {
  const choices = [choice("Distribution Group", "Sales, East", ["DL-Sales-East"])];
  assert.deepEqual(matchChoices({ emailDistroGroups: "Sales, East; Other" }, choices).m365, ["DL-Sales-East"]);
});

test("normalizeGroupList trims, drops blanks and duplicates, and bounds the input", () => {
  assert.deepEqual(normalizeGroupList("A\n a \n\nB;b"), { ok: true, value: ["A", "B"] });
  assert.deepEqual(normalizeGroupList(["X", "", "x"]), { ok: true, value: ["X"] });
  assert.deepEqual(normalizeGroupList(undefined), { ok: true, value: [] });
  assert.equal(normalizeGroupList(5).ok, false);
  assert.equal(normalizeGroupList([1]).ok, false);
  assert.equal(normalizeGroupList(Array.from({ length: 51 }, (_, i) => `g${i}`)).ok, false);
  assert.equal(normalizeGroupList(["x".repeat(257)]).ok, false);
});

// --- planner -------------------------------------------------------------------------------------

test("a mapped Cloud Application adds its Microsoft 365 and Google groups, with no group rule", () => {
  const client = { universalChoices: [choice("Cloud Applications", "Zoom", ["SSO - Zoom Pro Users"], ["zoom-users@x.com"])] };
  const out = resolvePlannedConfigs(client, { ...payload, cloudApplications: ["Zoom"] }, "onboard",
    [job("m365", { groups: ["Static"] }), job("google-workspace", {}), job("active-directory", {})]);
  assert.deepEqual(cfgOf(out, "m365").groups, ["Static", "SSO - Zoom Pro Users"]);
  assert.deepEqual(cfgOf(out, "google-workspace").groups, ["zoom-users@x.com"]);
  assert.equal(cfgOf(out, "active-directory").groups, undefined);
});

test("a MAPPED Security Group choice gets its mapping instead of its name; an unmapped one keeps its name", () => {
  const client = { universalChoices: [choice("Security Group", "Finance", ["SG-Finance-Cloud"]), choice("Security Group", "HR")] };
  const out = resolvePlannedConfigs(client, { ...payload, securityGroups: ["Finance", "HR", "Legal"] }, "onboard", [job("m365", {})]);
  assert.deepEqual(cfgOf(out, "m365").groups, ["HR", "Legal", "SG-Finance-Cloud"]);
});

test("a mapped Distribution Group choice replaces its name on the Graph lane", () => {
  const client = { universalChoices: [choice("Distribution Group", "All Boston Staff", ["dl-boston@x.com"])] };
  const out = resolvePlannedConfigs(client, { ...payload, emailDistroGroups: ["All Boston Staff", "Newsletter"] }, "onboard", [job("m365", {})]);
  assert.deepEqual(cfgOf(out, "m365").groups, ["Newsletter", "dl-boston@x.com"]);
});

test("exchange-only client: mapped Microsoft 365 groups go to exchange namedGroups", () => {
  const client = { universalChoices: [choice("Cloud Applications", "Zoom", ["DL-Zoom"])] };
  const out = resolvePlannedConfigs(client, { ...payload, cloudApplications: ["Zoom"] }, "onboard", [job("exchange", {})]);
  assert.deepEqual(cfgOf(out, "exchange").namedGroups, ["DL-Zoom"]);
});

test("mapped groups pass the same protected-groups filter as requested ones", () => {
  const client = { universalChoices: [choice("Role", "IT Admin", ["Domain Admins", "IT Staff"])] };
  const out = resolvePlannedConfigs(client, { ...payload, roles: ["IT Admin"] }, "onboard", [job("m365", {})]);
  assert.deepEqual(cfgOf(out, "m365").groups, ["IT Staff"]);
});

test("a client with no choices plans exactly as before", () => {
  const p = { ...payload, securityGroups: ["SG-Finance"], cloudApplications: ["Zoom"] };
  const before = resolvePlannedConfigs({}, p, "onboard", [job("m365", {}), job("google-workspace", {})]);
  const after = resolvePlannedConfigs({ universalChoices: [] }, p, "onboard", [job("m365", {}), job("google-workspace", {})]);
  assert.deepEqual(after, before);
});

// --- sync ----------------------------------------------------------------------------------------

type Row = { id: string; clientId: string; snSysId: string; question: string; label: string; value: string; m365Groups: string[]; googleGroups: string[]; goneAt: Date | null };
function fakeDb(rows: Row[]) {
  let n = rows.length;
  const universalChoice = {
    findMany: async () => rows.map((r) => ({ ...r })),
    create: async ({ data }: { data: Omit<Row, "id" | "m365Groups" | "googleGroups" | "goneAt"> }) => { rows.push({ ...data, id: `new${++n}`, m365Groups: [], googleGroups: [], goneAt: null } as Row); },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => { Object.assign(rows.find((r) => r.id === where.id)!, data); },
    updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Row> }) => { for (const r of rows) if (where.id.in.includes(r.id)) Object.assign(r, data); },
  };
  return { rows, db: { universalChoice, $transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ universalChoice }) } };
}

test("sync adds new choices, refreshes text, marks missing ones gone, and never touches a mapping", async () => {
  const { rows, db } = fakeDb([
    { id: "a", clientId: "c1", snSysId: "s1", question: "Cloud Applications", label: "Zoom", value: "zoom", m365Groups: ["SSO - Zoom"], googleGroups: [], goneAt: null },
    { id: "b", clientId: "c1", snSysId: "s2", question: "Cloud Applications", label: "Box", value: "box", m365Groups: ["Box Users"], googleGroups: [], goneAt: null },
    { id: "c", clientId: "c1", snSysId: "s3", question: "Role", label: "Intern", value: "intern", m365Groups: [], googleGroups: [], goneAt: new Date("2026-01-01") },
  ]);
  const now = new Date("2026-09-25T12:00:00Z");
  const r = await applyChoiceSync(db as never, "c1", [
    { sysId: "s1", question: "Cloud Applications", label: "Zoom Pro", value: "zoom" },   // renamed
    { sysId: "s3", question: "Role", label: "Intern", value: "intern" },                 // came back
    { sysId: "s4", question: "Security Group", label: "Finance", value: "finance" },      // new
    { sysId: "s4", question: "Security Group", label: "Finance", value: "finance" },      // duplicate row
  ], now);
  assert.deepEqual(r, { added: 1, updated: 2, gone: 1, total: 3 });
  const by = (s: string) => rows.find((x) => x.snSysId === s)!;
  assert.equal(by("s1").label, "Zoom Pro");
  assert.deepEqual(by("s1").m365Groups, ["SSO - Zoom"]);   // mapping kept through the rename
  assert.equal(by("s2").goneAt, now);                      // no longer returned: kept, marked gone
  assert.deepEqual(by("s2").m365Groups, ["Box Users"]);
  assert.equal(by("s3").goneAt, null);                     // returned again: un-marked
  assert.equal(rows.filter((x) => x.snSysId === "s4").length, 1);
});
