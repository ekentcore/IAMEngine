// List OPEN, UNASSIGNED User Management intake tickets — the work the automated poller imports. We
// only need each ticket's NUMBER here (the importer re-fetches the full record by number), so this is
// a cheap projection. In-scope = active (not closed) and not yet assigned to a tech. Tune INTAKE_QUERY
// if the account models "needs action" differently.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

const TABLE = "/api/now/table/sn_customerservice_user_management";

// active=true → open; assigned_toISEMPTY → nobody has picked it up. Newest first. Override via env
// SN_INTAKE_QUERY for a different scope without a code change.
const DEFAULT_QUERY = "active=true^assigned_toISEMPTY^ORDERBYDESCsys_created_on";
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
