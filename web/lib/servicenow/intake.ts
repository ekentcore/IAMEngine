// ServiceNow intake gateway: fetch a User Management case (the record both the
// "New User Request" and "Offboard User" record producers write to) by its number.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

// Records come back with sysparm_display_value=all, so each field is { value, display_value }.
export type SnUserMgmtRecord = Record<string, SnFieldValue>;

const INTAKE_FIELDS = [
  // routing / identity
  "number", "short_description", "subcategory", "account", "company", "opened_by",
  "contact_time_zone", "u_new_contact", "u_not_listed",
  // onboarding
  "u_first", "u_last", "u_mi", "u_start_date", "u_employment_type", "u_is_this_a_re_hire",
  "u_email_address_needed", "u_office_line_required", "description",
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
  "u_what_other_equipment_needs_to_be_collected", "u_other_unlisted_mailbox", "u_other_needs",
].join(",");

const TABLE = "/api/now/table/sn_customerservice_user_management";

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
  return rows[0] ?? null;
}
