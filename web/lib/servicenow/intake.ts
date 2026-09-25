// ServiceNow intake gateway: fetch a User Management case (the record both the
// "New User Request" and "Offboard User" record producers write to) by its number.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

// Records come back with sysparm_display_value=all, so each field is { value, display_value }.
export type SnUserMgmtRecord = Record<string, SnFieldValue>;

const INTAKE_FIELDS = [
  // routing / identity
  "number", "short_description", "subcategory", "account", "company", "opened_by", "contact",
  "contact_time_zone", "u_new_contact", "u_new_contact_time_zone", "u_not_listed", "u_new_or_existing",
  // onboarding — person
  "u_first", "u_last", "u_mi", "u_nickname", "u_start_date", "u_employment_type", "u_other_employment_type",
  "u_is_this_a_re_hire", "u_title", "u_department", "u_manager_name", "u_office_location",
  "u_personal_email", "u_personal_phone", "u_home_address", "u_is_their_primary_workspace_wfh",
  "u_will_this_individual_have_direct_reports", "u_who_are_direct_reports",
  "u_mirror_existing_user", "u_role_s", "u_coretelligent_list_membership",
  // onboarding — access / licensing
  "u_email_address_needed", "u_office_line_required", "u_cell_phone_line_required",
  "u_product_licenses", "u_security_groups_uc", "u_email_distro_groups_uc", "u_email_distro_groups",
  "u_shared_resource_mailboxes_uc", "u_shared_resource_mailboxes", "u_other_unlisted_mailbox",
  "u_file_share_access", "u_what_shares_should_they_have_access_to", "u_shared_drive_access_uc",
  "u_cloud_applications_uc", "u_cloud_applications", "u_other_cloud_application_needs",
  // onboarding — hardware / software
  "u_client_providing_asset", "u_computer_needed", "u_printer_s_needed", "u_monitors_needed",
  "u_monitor_stand_s_needed", "u_keyboard_mouse_combo", "u_docking_station_needed",
  "u_other_hardware_needed_uc", "u_other_hardware_opt_needed",
  "u_installed_software_uc", "u_installed_software", "u_other_software_needs",
  "description",
  // offboarding
  "u_end_date", "u_is_employee_aware_they_are_being_offboarded",
  "u_collect_cell_phone", "u_deactivate_cell_phone", "u_collect_desk_phone",
  "u_collect_computer", "u_computer_handling",
  "u_permitted_to_maintain_voicemail", "u_maintain_voicemail_until",
  "u_phone_voicemail_being_forwarded", "u_forward_to", "u_out_of_office_message",
  "u_enable_delegate", "u_off_delegate_access",
  "u_permitted_to_maintain_email", "u_maintain_email_until",
  "u_mail_forwarded", "u_forward_email_to",
  "u_permitted_to_maintain_file_share_access", "u_maintain_access_until",
  "u_what_other_equipment_needs_to_be_collected", "u_other_needs",
].join(",");

const TABLE = "/api/now/table/sn_customerservice_user_management";
const CONTACT_TABLE = "/api/now/table/customer_contact";

// Reference fields whose contact email we look up so the runner can match the mirror user / manager /
// the LEAVER (u_new_contact) by EMAIL (stable across ServiceNow & 365) rather than a display name
// that's often spelled differently (e.g. "James (Jim) Goodmiller" in SNOW vs "Jim Goodmiller" in 365).
// The resolved email is stashed on the record under "__email:<field>" for normalizeIntake to read.
const CONTACT_REF_FIELDS = ["u_manager_name", "u_mirror_existing_user", "u_forward_email_to", "u_new_contact"] as const;

// Resolve a set of customer_contact sys_ids -> their email. Best-effort: any failure (table not
// readable, a sys_id that isn't a customer_contact) just yields no email, and the caller falls back
// to the display name.
async function resolveContactEmails(config: SnConfig, sysIds: string[], fetcher: typeof fetch): Promise<Record<string, string>> {
  const ids = [...new Set(sysIds.filter(Boolean))];
  if (!ids.length) return {};
  try {
    const rows = await snGet<Array<Record<string, string>>>(
      config,
      CONTACT_TABLE,
      { sysparm_query: `sys_idIN${ids.join(",")}`, sysparm_fields: "sys_id,email", sysparm_display_value: "false", sysparm_limit: String(ids.length) },
      fetcher
    );
    const map: Record<string, string> = {};
    for (const row of rows ?? []) {
      if (row.sys_id && row.email) map[row.sys_id] = row.email;
    }
    return map;
  } catch {
    return {};
  }
}

// FR #174: the list (glide_list) fields the mapper reads. ServiceNow joins their display names with
// ", ", which is ambiguous when a name itself contains ", " — so for any list whose display doesn't
// split into as many names as it has sys_ids, look the names up by sys_id instead.
const LIST_FIELDS = [
  "u_who_are_direct_reports", "u_role_s", "u_coretelligent_list_membership", "u_product_licenses",
  "u_security_groups_uc", "u_email_distro_groups_uc", "u_email_distro_groups",
  "u_shared_resource_mailboxes_uc", "u_shared_resource_mailboxes",
  "u_what_shares_should_they_have_access_to", "u_shared_drive_access_uc",
  "u_cloud_applications_uc", "u_cloud_applications", "u_other_hardware_needed_uc", "u_other_hardware_opt_needed",
  "u_installed_software_uc", "u_installed_software", "u_off_delegate_access",
] as const;
const UM_TABLE_NAME = "sn_customerservice_user_management";
const DICTIONARY_TABLE = "/api/now/table/sys_dictionary";
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// Which table a list field references, and that table's display column — read from the dictionary
// once per field and kept for the life of the process. null = couldn't tell (e.g. the integration user
// may not read sys_dictionary); the mapper then flags the list instead of guessing. Only a found
// answer is cached, so a transient failure is retried on the next import (this path is rare).
type ListRef = { table: string; displayField: string };
const listRefCache = new Map<string, ListRef>();
async function listRefOf(config: SnConfig, field: string, fetcher: typeof fetch): Promise<ListRef | null> {
  const cached = listRefCache.get(field);
  if (cached) return cached;
  let ref: ListRef | null = null;
  try {
    const defs = await snGet<Array<Record<string, string>>>(
      config, DICTIONARY_TABLE,
      { sysparm_query: `element=${field}^referenceISNOTEMPTY`, sysparm_fields: "name,reference", sysparm_display_value: "false", sysparm_limit: "10" },
      fetcher
    );
    // The field may be defined on this table or on a parent; prefer this table's own definition.
    const def = (defs ?? []).find((d) => d.name === UM_TABLE_NAME) ?? (defs ?? [])[0];
    const table = def?.reference;
    if (table && TABLE_NAME_RE.test(table)) {
      const disp = await snGet<Array<Record<string, string>>>(
        config, DICTIONARY_TABLE,
        { sysparm_query: `name=${table}^display=true`, sysparm_fields: "element", sysparm_display_value: "false", sysparm_limit: "1" },
        fetcher
      );
      const displayField = (disp ?? [])[0]?.element;
      ref = { table, displayField: displayField && TABLE_NAME_RE.test(displayField) ? displayField : "name" };
    }
  } catch {
    ref = null;
  }
  if (ref) listRefCache.set(field, ref);
  return ref;
}

// The display names of a list field's records, in the field's own sys_id order. null when any of them
// can't be read — a partial list would silently drop a group.
async function resolveListNames(config: SnConfig, field: string, ids: string[], fetcher: typeof fetch): Promise<string[] | null> {
  const ref = await listRefOf(config, field, fetcher);
  if (!ref) return null;
  try {
    const rows = await snGet<Array<Record<string, string>>>(
      config, `/api/now/table/${ref.table}`,
      { sysparm_query: `sys_idIN${ids.join(",")}`, sysparm_fields: `sys_id,${ref.displayField}`, sysparm_display_value: "true", sysparm_limit: String(ids.length) },
      fetcher
    );
    const byId = new Map((rows ?? []).map((row) => [row.sys_id, (row[ref.displayField] ?? "").trim()]));
    const names = ids.map((id) => byId.get(id) ?? "");
    return names.every(Boolean) ? names : null;
  } catch {
    return null;
  }
}

// Test seam: forget cached dictionary lookups.
export function resetListRefCache(): void { listRefCache.clear(); }

export async function fetchUserManagementCase(
  config: SnConfig,
  number: string,
  fetcher: typeof fetch = fetch
): Promise<SnUserMgmtRecord | null> {
  assertConfig(config);
  const rows = await snGet<SnUserMgmtRecord[]>(
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
  const row = rows[0] ?? null;
  if (!row) return null;

  // Look up the manager / mirror-user contact emails and stash them on the record (best-effort).
  const sysIdOf = (f: string) => row[f]?.value ?? null;
  const emails = await resolveContactEmails(
    config,
    CONTACT_REF_FIELDS.map(sysIdOf).filter((x): x is string => Boolean(x)),
    fetcher
  );
  for (const f of CONTACT_REF_FIELDS) {
    const sid = sysIdOf(f);
    const email = sid ? emails[sid] : undefined;
    if (email) row[`__email:${f}`] = { value: email, display_value: email };
  }

  // FR #174: look up the names of any list whose display doesn't split cleanly (best-effort).
  for (const f of LIST_FIELDS) {
    const ids = (row[f]?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const shown = (row[f]?.display_value ?? "").split(", ").filter((s) => s.trim());
    if (ids.length < 2 || shown.length === ids.length) continue;
    const names = await resolveListNames(config, f, ids, fetcher);
    if (names) row[`__names:${f}`] = { value: JSON.stringify(names), display_value: names.join("; ") };
  }
  return row;
}
