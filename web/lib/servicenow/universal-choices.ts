// Read one client's Universal Choices from ServiceNow: the records its onboarding form's "_uc" list
// fields (u_cloud_applications_uc, u_security_groups_uc, …) pick from. Nothing here is hard-coded to
// an instance: the table is whatever those fields reference (sys_dictionary), and the Question /
// Label / Value / account columns are found on it by their labels. SN_UC_TABLE and SN_UC_FIELDS
// ("question=u_question,label=u_label,value=u_value,account=u_account") override the discovery.
import type { SnConfig } from "./types";
import { snGet, assertConfig, SnGatewayError } from "./http";

const DICTIONARY = "/api/now/table/sys_dictionary";
const NAME_RE = /^[a-z0-9_]{1,80}$/;
// The intake's Universal Choice list fields, tried in turn — any one of them names the table.
const UC_FIELDS = ["u_cloud_applications_uc", "u_security_groups_uc", "u_email_distro_groups_uc", "u_installed_software_uc", "u_shared_resource_mailboxes_uc", "u_shared_drive_access_uc", "u_other_hardware_needed_uc"];
// A reference to either of these is the column that says which client a choice belongs to.
const ACCOUNT_TABLES = ["customer_account", "core_company"];
const PAGE = 1000;
const MAX_ROWS = 10_000;

export type UcColumns = { question: string; label: string; value: string; account: string };
export type UcLayout = { table: string; columns: UcColumns };
export type SnChoice = { sysId: string; question: string; label: string; value: string };

type Row = Record<string, string>;
type DictRow = { element?: string; column_label?: string; reference?: string };

function envColumns(): Partial<UcColumns> {
  const out: Partial<UcColumns> = {};
  for (const part of (process.env.SN_UC_FIELDS ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x?.trim());
    if (v && NAME_RE.test(v) && (k === "question" || k === "label" || k === "value" || k === "account")) out[k] = v;
  }
  return out;
}

async function discoverTable(config: SnConfig, fetcher: typeof fetch): Promise<string | null> {
  const fromEnv = process.env.SN_UC_TABLE?.trim();
  if (fromEnv && NAME_RE.test(fromEnv)) return fromEnv;
  for (const field of UC_FIELDS) {
    const defs = await snGet<Row[]>(config, DICTIONARY,
      { sysparm_query: `element=${field}^referenceISNOTEMPTY`, sysparm_fields: "name,reference", sysparm_display_value: "false", sysparm_limit: "5" }, fetcher);
    const table = (defs ?? []).map((d) => d.reference).find((t) => t && NAME_RE.test(t));
    if (table) return table;
  }
  return null;
}

// The table's columns, its parents' included: a custom table often extends a base one, and
// sys_dictionary lists an inherited column only under the table that declares it.
async function columnsOf(config: SnConfig, table: string, fetcher: typeof fetch): Promise<DictRow[]> {
  const out: DictRow[] = [];
  let t: string | null = table;
  for (let depth = 0; t && depth < 4; depth++) {
    const rows = await snGet<DictRow[]>(config, DICTIONARY,
      { sysparm_query: `name=${t}^elementISNOTEMPTY`, sysparm_fields: "element,column_label,reference", sysparm_display_value: "false", sysparm_limit: "500" }, fetcher);
    out.push(...(rows ?? []));
    const obj: Row[] = await snGet<Row[]>(config, "/api/now/table/sys_db_object",
      { sysparm_query: `name=${t}`, sysparm_fields: "super_class.name", sysparm_display_value: "false", sysparm_limit: "1" }, fetcher);
    const parent: string | undefined = (obj ?? [])[0]?.["super_class.name"];
    t = parent && NAME_RE.test(parent) && parent !== t ? parent : null;
  }
  return out;
}

// Pick the four columns from the dictionary rows. Pure, for the tests.
export function pickColumns(rows: readonly DictRow[], overrides: Partial<UcColumns> = {}): { ok: true; columns: UcColumns } | { ok: false; missing: string[] } {
  const byLabel = (re: RegExp) => rows.find((r) => r.element && NAME_RE.test(r.element) && re.test((r.column_label ?? "").trim()))?.element;
  const account = rows.find((r) => r.element && NAME_RE.test(r.element) && ACCOUNT_TABLES.includes(r.reference ?? ""))?.element;
  const found: Partial<UcColumns> = {
    question: overrides.question ?? byLabel(/^questions?$/i),
    label: overrides.label ?? byLabel(/^label$/i),
    value: overrides.value ?? byLabel(/^value$/i),
    account: overrides.account ?? account,
  };
  const missing = (["question", "label", "value", "account"] as const).filter((k) => !found[k]);
  return missing.length ? { ok: false, missing } : { ok: true, columns: found as UcColumns };
}

let layoutCache: UcLayout | null = null;
export function resetUcLayoutCache(): void { layoutCache = null; }

export async function discoverUcLayout(config: SnConfig, fetcher: typeof fetch = fetch): Promise<UcLayout> {
  if (layoutCache) return layoutCache;
  const table = await discoverTable(config, fetcher);
  if (!table) throw new SnGatewayError("couldn't find the Universal Choice table: none of the intake's _uc fields reference a table (set SN_UC_TABLE to name it)");
  const picked = pickColumns(await columnsOf(config, table, fetcher), envColumns());
  if (!picked.ok) {
    throw new SnGatewayError(`found the Universal Choice table (${table}) but not its ${picked.missing.join(", ")} column(s) — set SN_UC_FIELDS, e.g. "question=u_question,label=u_label"`);
  }
  layoutCache = { table, columns: picked.columns };
  return layoutCache;
}

// Every Universal Choice ServiceNow holds for one client account (customer_account sys_id).
export async function fetchClientChoices(config: SnConfig, accountSysId: string, fetcher: typeof fetch = fetch): Promise<SnChoice[]> {
  assertConfig(config);
  if (!/^[0-9a-f]{32}$/i.test(accountSysId)) throw new SnGatewayError("the client's ServiceNow account id is not a sys_id");
  const { table, columns: c } = await discoverUcLayout(config, fetcher);
  const out: SnChoice[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const rows = await snGet<Row[]>(config, `/api/now/table/${table}`, {
      sysparm_query: `${c.account}=${accountSysId}^ORDERBY${c.question}^ORDERBY${c.label}`,
      sysparm_fields: `sys_id,${c.question},${c.label},${c.value}`,
      // Display text: the Question may be a choice or a reference, and the planner matches the
      // intake's display names.
      sysparm_display_value: "true",
      sysparm_limit: String(PAGE),
      sysparm_offset: String(offset),
    }, fetcher);
    for (const r of rows ?? []) {
      const sysId = (r.sys_id ?? "").trim();
      const label = (r[c.label] ?? "").trim();
      if (!sysId || !label) continue;
      out.push({ sysId, question: (r[c.question] ?? "").trim(), label, value: (r[c.value] ?? "").trim() });
    }
    if ((rows ?? []).length < PAGE) break;
  }
  return out;
}
