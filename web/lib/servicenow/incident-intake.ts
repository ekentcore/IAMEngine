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

// Offboarding record-producer variables (the departing user's identity + end date). The exact set
// varies by form revision, so we request a tolerant superset — unknown fields just come back empty.
const OFFBOARD_VARS = [
  "u_user", "u_employee", "u_name", "u_full_name", "u_display_name", "u_offboard_user",
  "u_email", "u_user_email", "u_username", "u_user_principal_name", "u_upn",
  "u_first_name", "u_last_name", "u_last_day", "u_end_date", "u_termination_date",
  "u_manager", "u_department", "u_computer_name", "u_computer",
];

const INTAKE_FIELDS = [...INCIDENT_COLS, ...[...new Set([...ONBOARD_VARS, ...OFFBOARD_VARS])].map((v) => `variables.${v}`)].join(",");

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

function subAndProducer(r: SnIncidentRecord): string {
  const sub = String((r["subcategory"] as { display_value?: string })?.display_value ?? (r["subcategory"] as { value?: string })?.value ?? "").toLowerCase();
  const producer = String((r["u_producer"] as { display_value?: string })?.display_value ?? (r["u_producer"] as { value?: string })?.value ?? "").toLowerCase();
  return `${sub} ${producer}`;
}

// True when an incident is an internal onboarding request (subcategory or producer signal).
export function isOnboardingIncident(r: SnIncidentRecord): boolean {
  return /on-?boarding/.test(subAndProducer(r));
}

// True when an incident is an internal OFFboarding request. Checked before onboarding so the
// "off-boarding" string isn't shadowed by the looser "boarding" match.
export function isOffboardingIncident(r: SnIncidentRecord): boolean {
  return /off-?boarding/.test(subAndProducer(r));
}

// onboard | offboard | null (not a user lifecycle incident). Offboard is tested first because
// "off-boarding" also contains "boarding".
export function incidentAction(r: SnIncidentRecord): "onboard" | "offboard" | null {
  if (isOffboardingIncident(r)) return "offboard";
  if (isOnboardingIncident(r)) return "onboard";
  return null;
}
