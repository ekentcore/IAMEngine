// ServiceNow intake gateway: fetch a User Management case (the record both the
// "New User Request" and "Offboard User" record producers write to) by its number.
import type { SnConfig, SnFieldValue } from "./types";
import { snGet, assertConfig } from "./http";

// Records come back with sysparm_display_value=all, so each field is { value, display_value }.
export type SnUserMgmtRecord = Record<string, SnFieldValue>;

const INTAKE_FIELDS = [
  // routing / identity
  "number", "short_description", "subcategory", "account", "company", "opened_by",
  "contact_time_zone", "u_new_contact", "u_new_contact_time_zone", "u_not_listed", "u_new_or_existing",
  // onboarding — person
  "u_first", "u_last", "u_mi", "u_start_date", "u_employment_type", "u_other_employment_type",
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
