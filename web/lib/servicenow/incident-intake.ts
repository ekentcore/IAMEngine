// ServiceNow incident intake (internal Coretelligent onboarding). Internal new-hire requests are
// filed as `incident` records via the "User On-Boarding Request" record producer — the form data
// lives in PRODUCER VARIABLES, not columns, so we dot-walk `variables.<name>` (the only path the
// service account can read; question_answer / sys_variable_value are ACL-blocked). The record comes
// back flat with dotted keys, e.g. record["variables.u_first_name"] = { value, display_value }.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

export type SnIncidentRecord = Record<string, SnFieldValue>;

// Incident columns we route/identify on.
const INCIDENT_COLS = ["number", "short_description", "subcategory", "category", "company", "opened_by", "state", "sys_id", "u_producer"];

// Record-producer variables (authoritative list from item_option_new on "User On-Boarding Request",
// minus formatters/containers). description-the-variable is "Notes / Special Requests".
const ONBOARD_VARS = [
  "u_first_name", "u_last_name", "u_nickname", "u_personal_email", "u_phone_number",
  "u_workspace_location", "u_office_location", "u_department", "u_hiring_manager",
  "u_title", "u_start_date", "u_employment_type", "u_recruiter", "cost_center",
  "u_equip_amex", "u_shipping", "description",
  // India / Aadhaar legal-name variants (Podshore hires)
  "given_name", "given_pref_name", "family_name", "father_name", "Aadhaar_name",
];

const INTAKE_FIELDS = [...INCIDENT_COLS, ...ONBOARD_VARS.map((v) => `variables.${v}`)].join(",");

const TABLE = "/api/now/table/incident";

// Fetch an incident by number with its onboarding producer variables. Returns null if not found.
export async function fetchOnboardingIncident(
  config: SnConfig,
  number: string,
  fetcher: typeof fetch = fetch
): Promise<SnIncidentRecord | null> {
  assertConfig(config);
  const rows = await snGet<SnIncidentRecord[]>(
    config,
    TABLE,
    {
      sysparm_query: `number=${number}`,
      sysparm_fields: INTAKE_FIELDS,
      sysparm_display_value: "all",
      sysparm_limit: "1",
    },
    fetcher
  );
  return rows?.[0] ?? null;
}

// True when an incident is an internal onboarding request (subcategory or producer signal).
export function isOnboardingIncident(r: SnIncidentRecord): boolean {
  const sub = String((r["subcategory"] as { display_value?: string })?.display_value ?? (r["subcategory"] as { value?: string })?.value ?? "").toLowerCase();
  const producer = String((r["u_producer"] as { display_value?: string })?.display_value ?? (r["u_producer"] as { value?: string })?.value ?? "").toLowerCase();
  return sub.includes("on-boarding") || sub.includes("onboarding") || producer.includes("on-boarding") || producer.includes("onboarding");
}
