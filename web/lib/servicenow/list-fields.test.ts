import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake } from "./intake-mapper";
import { fetchUserManagementCase, resetListRefCache } from "./intake";
import type { SnUserMgmtRecord } from "./intake";
import { resolvePlannedConfigs } from "../profiles/plan-resolve";
import type { PlannedJob } from "../orchestrator";
import { splitTypedList, LIST_PAYLOAD_FIELDS } from "../cases/typed-list";

// FR #174: ServiceNow joins a list field's display names with ", ", so a DL named "Sales, East" came
// through as two groups. The sys_id list in `value` is the unambiguous count.

function rec(fields: Record<string, string | [string, string]>): SnUserMgmtRecord {
  const out: SnUserMgmtRecord = {};
  for (const [k, v] of Object.entries(fields)) {
    const [value, display] = Array.isArray(v) ? v : [v, v];
    out[k] = { value, display_value: display } as never;
  }
  return out;
}
const onboard = (extra: Record<string, string | [string, string]>) =>
  normalizeIntake(rec({ number: "UM1", subcategory: "30000", u_first: "A", u_last: "B", u_office_location: ["x", "Atlanta, GA"], ...extra })).payload;
const ID1 = "a".repeat(32), ID2 = "b".repeat(32), ID3 = "c".repeat(32);

test("one distro group whose name contains a comma stays one group", () => {
  const p = onboard({ u_email_distro_groups_uc: [ID1, "Sales, East"] });
  assert.deepEqual(p.emailDistroGroups, ["Sales, East"]);
  assert.deepEqual(p.unknownFields, []);
});

test("an ordinary multi-group list splits as before", () => {
  const p = onboard({ u_email_distro_groups_uc: [`${ID1},${ID2}`, "Sales, Finance"] });
  assert.deepEqual(p.emailDistroGroups, ["Sales", "Finance"]);
  assert.deepEqual(p.unknownFields, []);
});

test("names looked up by sys_id win over the ambiguous display", () => {
  const p = onboard({
    u_email_distro_groups_uc: [`${ID1},${ID2}`, "Sales, East, Finance"],
    "__names:u_email_distro_groups_uc": JSON.stringify(["Sales, East", "Finance"]),
  });
  assert.deepEqual(p.emailDistroGroups, ["Sales, East", "Finance"]);
  assert.deepEqual(p.unknownFields, []);
});

test("an ambiguous multi-group list with no looked-up names holds the case with a fill-in, not a guess", () => {
  const p = onboard({ u_security_groups_uc: [`${ID1},${ID2}`, "VPN, Remote, Finance"] });
  const unk = p.unknownFields as { field: string; note: string }[];
  assert.equal(unk.length, 1);
  assert.equal(unk[0].field, "securityGroups");
  assert.match(unk[0].note, /2 entries as "VPN, Remote, Finance".*semicolons/);
});

// A fake ServiceNow: the UM record, the dictionary, and the referenced group table.
function fakeSn(opts: { dictionary?: "ok" | "forbidden"; display?: string } = {}) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const u = new URL(url);
    calls.push(`${u.pathname}?${u.searchParams.get("sysparm_query")}`);
    const json = (result: unknown, status = 200) => new Response(JSON.stringify({ result }), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/sn_customerservice_user_management")) {
      return json([{
        number: { value: "UM1", display_value: "UM1" }, subcategory: { value: "30000", display_value: "User Onboarding" },
        u_first: { value: "A", display_value: "A" }, u_last: { value: "B", display_value: "B" },
        u_office_location: { value: "x", display_value: "Atlanta, GA" },
        u_email_distro_groups_uc: { value: `${ID1},${ID2}`, display_value: opts.display ?? "Sales, East, Finance" },
      }]);
    }
    if (u.pathname.endsWith("/sys_dictionary")) {
      if (opts.dictionary === "forbidden") return json({ error: "no" }, 403);
      const q = u.searchParams.get("sysparm_query") ?? "";
      if (q.startsWith("element=u_email_distro_groups_uc")) return json([{ name: "sn_customerservice_user_management", reference: "u_client_group" }]);
      if (q.startsWith("name=u_client_group^display=true")) return json([{ element: "u_group_name" }]);
      return json([]);
    }
    if (u.pathname.endsWith("/u_client_group")) {
      // Out of order on purpose: the field's own sys_id order decides.
      return json([{ sys_id: ID2, u_group_name: "Finance" }, { sys_id: ID1, u_group_name: "Sales, East" }]);
    }
    if (u.pathname.endsWith("/customer_contact")) return json([]);
    return json([]);
  }) as typeof fetch;
  return { fetcher, calls };
}
const cfg = { instanceUrl: "https://x.service-now.com", username: "u", password: "p" };
beforeEach(() => resetListRefCache());

test("the fetch looks the names up through the dictionary when the display is ambiguous", async () => {
  const sn = fakeSn();
  const row = await fetchUserManagementCase(cfg, "UM1", sn.fetcher);
  const p = normalizeIntake(row!).payload;
  assert.deepEqual(p.emailDistroGroups, ["Sales, East", "Finance"]);
  assert.deepEqual(p.unknownFields, []);
  assert.ok(sn.calls.some((c) => c.startsWith("/api/now/table/u_client_group?sys_idIN")));
});

test("no extra ServiceNow calls when the display already splits cleanly", async () => {
  const sn = fakeSn({ display: "Sales, Finance" });
  const row = await fetchUserManagementCase(cfg, "UM1", sn.fetcher);
  assert.deepEqual(normalizeIntake(row!).payload.emailDistroGroups, ["Sales", "Finance"]);
  assert.equal(sn.calls.some((c) => c.includes("sys_dictionary")), false);
});

test("a dictionary the integration user can't read falls back to the hold, not a wrong split", async () => {
  const sn = fakeSn({ dictionary: "forbidden" });
  const row = await fetchUserManagementCase(cfg, "UM1", sn.fetcher);
  const unk = normalizeIntake(row!).payload.unknownFields as { field: string }[];
  assert.deepEqual(unk.map((u) => u.field), ["emailDistroGroups"]);
});

function job(systemKey: string): PlannedJob {
  return { systemKey, sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} };
}

test("a typed list separated by semicolons keeps a comma inside a name; a plain comma list reads as before", () => {
  const groups = (v: string) => (resolvePlannedConfigs({}, { emailDistroGroups: v }, "onboard", [job("m365")])[0].config as { groups: string[] }).groups;
  assert.deepEqual(groups("Sales, East; Finance"), ["Sales, East", "Finance"]);
  assert.deepEqual(groups("Sales, Finance"), ["Sales", "Finance"]);
});

test("the case fill-in stores a typed group list as an array, split the same way", () => {
  assert.deepEqual(splitTypedList("Sales, East; Finance"), ["Sales, East", "Finance"]);
  assert.deepEqual(splitTypedList(" Sales , Finance "), ["Sales", "Finance"]);
  assert.deepEqual(splitTypedList("  "), []);
  for (const f of ["emailDistroGroups", "securityGroups", "sharedMailboxes"]) assert.ok(LIST_PAYLOAD_FIELDS.has(f), f);
  assert.equal(LIST_PAYLOAD_FIELDS.has("department"), false);
});
