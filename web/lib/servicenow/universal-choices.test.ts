import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchClientChoices, pickColumns, resetUcLayoutCache } from "./universal-choices";

const config = { instanceUrl: "https://sn.example", username: "u", password: "p" };
const ACCT = "0123456789abcdef0123456789abcdef";

type Handler = (path: string, q: URLSearchParams) => unknown;
function fakeSn(handler: Handler) {
  const calls: { path: string; q: URLSearchParams }[] = [];
  const fetcher = (async (url: string) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, q: u.searchParams });
    return new Response(JSON.stringify({ result: handler(u.pathname, u.searchParams) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// A custom table extending a base: Label/Value are its own columns, Question and the account
// reference are inherited from the parent.
const handler: Handler = (path, q) => {
  const query = q.get("sysparm_query") ?? "";
  if (path.endsWith("/sys_dictionary") && query.startsWith("element=u_cloud_applications_uc")) return [{ name: "sn_customerservice_case", reference: "u_universal_choice" }];
  if (path.endsWith("/sys_dictionary") && query.startsWith("name=u_universal_choice^")) return [{ element: "u_label", column_label: "Label" }, { element: "u_value", column_label: "Value" }];
  if (path.endsWith("/sys_dictionary") && query.startsWith("name=u_choice_base^")) return [{ element: "u_question", column_label: "Questions" }, { element: "u_account", column_label: "Account", reference: "customer_account" }];
  if (path.endsWith("/sys_db_object")) return query === "name=u_universal_choice" ? [{ "super_class.name": "u_choice_base" }] : [{ "super_class.name": "" }];
  if (path.endsWith("/u_universal_choice")) {
    if (q.get("sysparm_offset") === "0") return [
      { sys_id: "s1", u_question: "Cloud Applications", u_label: " Zoom ", u_value: "zoom" },
      { sys_id: "s2", u_question: "Security Group", u_label: "", u_value: "blank-label" },   // no label: skipped
    ];
    return [];
  }
  return [];
};

beforeEach(() => { resetUcLayoutCache(); delete process.env.SN_UC_TABLE; delete process.env.SN_UC_FIELDS; });

test("finds the table from an intake _uc field and its columns, including inherited ones", async () => {
  const { fetcher, calls } = fakeSn(handler);
  const out = await fetchClientChoices(config, ACCT, fetcher);
  assert.deepEqual(out, [{ sysId: "s1", question: "Cloud Applications", label: "Zoom", value: "zoom" }]);
  const read = calls.find((c) => c.path.endsWith("/u_universal_choice"))!;
  assert.equal(read.q.get("sysparm_query"), `u_account=${ACCT}^ORDERBYu_question^ORDERBYu_label`);
  assert.equal(read.q.get("sysparm_fields"), "sys_id,u_question,u_label,u_value");
  assert.equal(read.q.get("sysparm_display_value"), "true");
});

test("reads every page", async () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ sys_id: `p${i}`, u_question: "Role", u_label: `R${i}`, u_value: `r${i}` }));
  const { fetcher } = fakeSn((path, q) => path.endsWith("/u_universal_choice")
    ? (q.get("sysparm_offset") === "0" ? many : [{ sys_id: "last", u_question: "Role", u_label: "Last", u_value: "last" }])
    : handler(path, q));
  const out = await fetchClientChoices(config, ACCT, fetcher);
  assert.equal(out.length, 1001);
  assert.equal(out.at(-1)!.label, "Last");
});

test("SN_UC_TABLE and SN_UC_FIELDS override the discovery", async () => {
  process.env.SN_UC_TABLE = "x_custom_uc";
  process.env.SN_UC_FIELDS = "question=x_q,label=x_l,value=x_v,account=x_acct";
  const { fetcher, calls } = fakeSn((path) => (path.endsWith("/x_custom_uc") ? [{ sys_id: "s9", x_q: "Role", x_l: "Manager", x_v: "mgr" }] : []));
  const out = await fetchClientChoices(config, ACCT, fetcher);
  assert.deepEqual(out, [{ sysId: "s9", question: "Role", label: "Manager", value: "mgr" }]);
  assert.ok(!calls.some((c) => c.q.get("sysparm_query")?.startsWith("element=")), "no table discovery when the table is named");
});

test("names the missing columns instead of reading the wrong ones", () => {
  const r = pickColumns([{ element: "u_label", column_label: "Label" }]);
  assert.deepEqual(r, { ok: false, missing: ["question", "value", "account"] });
});

test("refuses an account id that isn't a sys_id (it goes into a query)", async () => {
  const { fetcher } = fakeSn(handler);
  await assert.rejects(fetchClientChoices(config, "abc^ORactive=true", fetcher), /not a sys_id/);
});

test("a clear error when no _uc field references a table", async () => {
  const { fetcher } = fakeSn(() => []);
  await assert.rejects(fetchClientChoices(config, ACCT, fetcher), /couldn't find the Universal Choice table/);
});
