// List OPEN, UNASSIGNED User Management intake tickets — the work the automated poller imports. We
// only need each ticket's NUMBER here (the importer re-fetches the full record by number), so this is
// a cheap projection. In-scope = active (not closed) and not yet assigned to a tech. Tune INTAKE_QUERY
// if the account models "needs action" differently.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";
import { incidentAction, type SnIncidentRecord } from "./incident-intake";
import { NON_LIFECYCLE_SUBCATEGORIES } from "./intake-mapper";

const TABLE = "/api/now/table/sn_customerservice_user_management";
const INCIDENT_TABLE = "/api/now/table/incident";

// active=true → open; assigned_toISEMPTY → nobody has picked it up. Exclude non-lifecycle subcategories
// (e.g. Computer Build / 30300) at the source so the poller never even fetches them. Newest first.
// Override via env SN_INTAKE_QUERY for a different scope without a code change.
const EXCLUDE_SUBCATS = Object.keys(NON_LIFECYCLE_SUBCATEGORIES).map((c) => `subcategory!=${c}`).join("^");
// Only auto-import tickets routed to the IAM pod: the open queue is POD-IAM / POD-IAM-L1 (IAM's work)
// vs CoreIT / POD-Gold (other teams). "contains IAM" catches POD-IAM* (incl. future L2) and excludes
// the rest. Tune the token via SN_INTAKE_ASSIGNMENT_GROUP_LIKE; set it empty to disable the filter.
// (UM table only — internal incidents route to TEAM-InternalSupport, not IAM.)
const ASSIGN_GROUP_LIKE = (process.env.SN_INTAKE_ASSIGNMENT_GROUP_LIKE ?? "IAM").trim();
const ASSIGN_GROUP_CLAUSE = ASSIGN_GROUP_LIKE ? `^assignment_group.nameLIKE${ASSIGN_GROUP_LIKE}` : "";
const DEFAULT_QUERY = `active=true^assigned_toISEMPTY${EXCLUDE_SUBCATS ? `^${EXCLUDE_SUBCATS}` : ""}${ASSIGN_GROUP_CLAUSE}^ORDERBYDESCsys_created_on`;
// Internal on/off-boarding incidents: open, unassigned, and the lifecycle signal lives in EITHER the
// subcategory OR the record producer (^OR groups with the immediately-preceding LIKE). We still confirm
// each row client-side with incidentAction so a loose "boarding" match can't import a non-lifecycle INC.
const DEFAULT_INCIDENT_QUERY =
  "active=true^assigned_toISEMPTY^subcategoryLIKEoarding^ORu_producerLIKEoarding^ORDERBYDESCsys_created_on";
const PAGE_SIZE = 100;

export async function fetchOpenIntakeNumbers(config: SnConfig, fetcher: typeof fetch = fetch, max = 500): Promise<string[]> {
  assertConfig(config);
  const query = process.env.SN_INTAKE_QUERY || DEFAULT_QUERY;
  const out: string[] = [];
  for (let offset = 0; offset < max; offset += PAGE_SIZE) {
    const page = await snGet<Record<string, SnFieldValue>[]>(
      config,
      TABLE,
      { sysparm_query: query, sysparm_fields: "number", sysparm_display_value: "false", sysparm_limit: String(PAGE_SIZE), sysparm_offset: String(offset) },
      fetcher
    );
    for (const r of page) {
      const n = typeof r.number === "string" ? r.number : (r.number as { value?: string } | undefined)?.value;
      if (n) out.push(n);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

// List OPEN, UNASSIGNED internal on/off-boarding INCIDENTS for the poller. We pull subcategory +
// u_producer so incidentAction() can confirm each row is truly a lifecycle incident (the SN query is a
// broad "boarding" LIKE), then return only the confirmed numbers. Override scope via SN_INTAKE_INCIDENT_QUERY.
export async function fetchOpenIncidentNumbers(config: SnConfig, fetcher: typeof fetch = fetch, max = 500): Promise<string[]> {
  assertConfig(config);
  const query = process.env.SN_INTAKE_INCIDENT_QUERY || DEFAULT_INCIDENT_QUERY;
  const out: string[] = [];
  for (let offset = 0; offset < max; offset += PAGE_SIZE) {
    const page = await snGet<SnIncidentRecord[]>(
      config,
      INCIDENT_TABLE,
      { sysparm_query: query, sysparm_fields: "number,subcategory,u_producer", sysparm_display_value: "all", sysparm_limit: String(PAGE_SIZE), sysparm_offset: String(offset) },
      fetcher
    );
    for (const r of page) {
      if (!incidentAction(r)) continue; // not a real lifecycle incident — skip
      const cell = r.number as { value?: string } | string | undefined;
      const n = typeof cell === "string" ? cell : cell?.value;
      if (n) out.push(n);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}
