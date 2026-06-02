// Ad-hoc ServiceNow case dump.
//   node scripts/sn-get.mjs <UMxxxx> [field1,field2,...] [--json] [--all]
//
// - With no field list: pulls EVERY u_* field on sn_customerservice_user_management
//   (plus number/short_description) so nothing is missed.
// - For any field whose readable value differs from the raw value (references, choices,
//   glide_lists, dates), also emits "<field>_display" with the human-readable text.
// - Shows the dictionary column label for every field.
// Reads ServiceNow creds from ../env.env (SN_INSTANCE_URL, SN_USER|SN_USERNAME, SN_PASSWORD).
import { parseEnvFile } from "./read-env.mjs";

const TABLE = "sn_customerservice_user_management";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const wantAll = args.includes("--all");
const positional = args.filter((a) => !a.startsWith("--"));
const number = positional[0];
const explicitFields = positional[1] ? positional[1].split(",").map((s) => s.trim()).filter(Boolean) : null;

if (!number) {
  console.error("usage: node scripts/sn-get.mjs <UMxxxx> [field1,field2,...] [--json] [--all]");
  process.exit(1);
}

const env = parseEnvFile();
const base = env.SN_INSTANCE_URL;
const user = env.SN_USER || env.SN_USERNAME;
const pass = env.SN_PASSWORD;
if (!base || !user || !pass) {
  console.error("missing SN_INSTANCE_URL / SN_USER / SN_PASSWORD in env.env");
  process.exit(1);
}
const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

async function snGet(path, params) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).result;
}

// 1. Dictionary: labels + types for u_* fields on the table (used for labels and field set).
const dict = await snGet("/api/now/table/sys_dictionary", {
  sysparm_query: `name=${TABLE}^elementSTARTSWITHu_`,
  sysparm_fields: "element,column_label,internal_type",
  sysparm_limit: "500",
});
const meta = {};
for (const r of dict) {
  const el = r.element?.value ?? r.element;
  if (!el) continue;
  meta[el] = { label: r.column_label?.value ?? r.column_label ?? "", type: r.internal_type?.value ?? r.internal_type ?? "" };
}

// 2. Decide which fields to fetch.
const baseFields = ["number", "short_description"];
const uFields = explicitFields ?? Object.keys(meta).sort();
const fields = [...baseFields, ...uFields];

// 3. Fetch the record (display_value=all gives {value, display_value} per field).
const rows = await snGet(`/api/now/table/${TABLE}`, {
  sysparm_query: `number=${number}`,
  sysparm_fields: fields.join(","),
  sysparm_display_value: "all",
  sysparm_limit: "1",
});
if (!rows.length) {
  console.error(`no record found for ${number}`);
  process.exit(2);
}
const rec = rows[0];

// 4. Build output: value, optional _display, and label per field.
const out = {};
for (const f of fields) {
  const cell = rec[f];
  const value = cell && typeof cell === "object" ? cell.value : cell;
  const display = cell && typeof cell === "object" ? cell.display_value : undefined;
  out[f] = value ?? "";
  if (display != null && display !== "" && display !== value) out[`${f}_display`] = display;
}

if (asJson) {
  console.log(JSON.stringify({ number, fields: out, labels: Object.fromEntries(uFields.map((f) => [f, meta[f]?.label ?? null])) }, null, 2));
} else {
  const pad = Math.max(...fields.map((f) => f.length)) + 2;
  console.log(`${number}  —  ${out.short_description || ""}\n`);
  for (const f of fields) {
    const label = meta[f]?.label ? `  «${meta[f].label}»` : "";
    const v = out[f] === "" ? "—" : out[f];
    console.log(`${f.padEnd(pad)} ${v}${label}`);
    if (out[`${f}_display`] !== undefined) {
      console.log(`${(f + "_display").padEnd(pad)} ${out[`${f}_display`]}`);
    }
  }
}
