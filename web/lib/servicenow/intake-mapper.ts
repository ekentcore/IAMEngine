// Pure mapping: a raw User Management record -> a normalized case (action + client link +
// intake payload shaped per docs/DATA_MODEL.md). No I/O. Unit-testable with a fixture.
import type { SnUserMgmtRecord } from "./intake";

export type IntakeAction = "onboard" | "offboard";

export type NormalizedIntake = {
  action: IntakeAction;
  clientSysId: string | null; // account/company sys_id -> Client.serviceNowSysId
  caseNumber: string; // UM number
  subject: string;
  payload: Record<string, unknown>;
};

const val = (r: SnUserMgmtRecord, k: string): string | null => {
  const v = r[k]?.value;
  return v == null || v === "" ? null : v;
};
const disp = (r: SnUserMgmtRecord, k: string): string | null => {
  const v = r[k]?.display_value;
  return v == null || v === "" ? null : v;
};
const bool = (r: SnUserMgmtRecord, k: string): boolean => r[k]?.value === "true";
const trimmed = (s: string | null): string | null => (s ? s.trim() : null);
// SN datetimes come as "2026-06-15 19:34:29"; keep the date.
const dateOnly = (s: string | null): string | null => (s ? s.split(" ")[0] : null);

function deriveAction(r: SnUserMgmtRecord): IntakeAction {
  const sub = (disp(r, "subcategory") ?? "").toLowerCase();
  const short = (val(r, "short_description") ?? "").toLowerCase();
  if (sub.includes("offboard") || short.includes("offboard")) return "offboard";
  return "onboard";
}

function onboardPayload(r: SnUserMgmtRecord): Record<string, unknown> {
  return {
    firstName: trimmed(val(r, "u_first")),
    lastName: trimmed(val(r, "u_last")),
    mi: trimmed(val(r, "u_mi")),
    startDate: dateOnly(val(r, "u_start_date")),
    isRehire: (val(r, "u_is_this_a_re_hire") ?? "").toLowerCase() === "yes",
    employmentType: disp(r, "u_employment_type") ?? val(r, "u_employment_type"),
    emailAddressNeeded: (val(r, "u_email_address_needed") ?? "").toLowerCase() === "yes",
    officeLineRequired: (val(r, "u_office_line_required") ?? "").toLowerCase() === "yes",
    timezone: val(r, "contact_time_zone"),
    requestedBy: disp(r, "opened_by"),
    otherNeeds: val(r, "u_other_needs"),
    description: val(r, "description"),
  };
}

function offboardPayload(r: SnUserMgmtRecord): Record<string, unknown> {
  return {
    userToOffboard: disp(r, "u_new_contact") ?? [trimmed(val(r, "u_first")), trimmed(val(r, "u_last"))].filter(Boolean).join(" "),
    notListedUser: bool(r, "u_not_listed"),
    dateOfOffboarding: dateOnly(val(r, "u_end_date")),
    timezone: val(r, "contact_time_zone"),
    employeeAware: bool(r, "u_is_employee_aware_they_are_being_offboarded"),
    collectCellPhone: bool(r, "u_collect_cell_phone"),
    deactivateCellPhone: bool(r, "u_deactivate_cell_phone"),
    collectDeskPhone: bool(r, "u_collect_desk_phone"),
    collectComputer: bool(r, "u_collect_computer") || !!disp(r, "u_computer_handling"),
    maintainVoicemail: bool(r, "u_permitted_to_maintain_voicemail"),
    maintainVoicemailUntil: dateOnly(val(r, "u_maintain_voicemail_until")),
    forwardPhoneVoicemail: bool(r, "u_phone_voicemail_being_forwarded"),
    forwardPhoneTo: val(r, "u_forward_to"),
    oooMessage: val(r, "u_out_of_office_message"),
    provideMailboxAccessTo: bool(r, "u_enable_delegate") ? disp(r, "u_off_delegate_access") : null,
    allowedToMaintainEmail: bool(r, "u_permitted_to_maintain_email"),
    maintainEmailUntil: dateOnly(val(r, "u_maintain_email_until")),
    mailForwarded: bool(r, "u_mail_forwarded"),
    forwardEmailTo: val(r, "u_forward_email_to"),
    maintainFileShareAccess: bool(r, "u_permitted_to_maintain_file_share_access"),
    maintainAccessUntil: dateOnly(val(r, "u_maintain_access_until")),
    otherEquipment: val(r, "u_what_other_equipment_needs_to_be_collected"),
    otherNeeds: val(r, "u_other_needs"),
  };
}

export function normalizeIntake(r: SnUserMgmtRecord): NormalizedIntake {
  const action = deriveAction(r);
  return {
    action,
    clientSysId: val(r, "account") ?? val(r, "company"),
    caseNumber: val(r, "number") ?? "",
    subject: val(r, "short_description") ?? val(r, "number") ?? "Imported case",
    payload: action === "onboard" ? onboardPayload(r) : offboardPayload(r),
  };
}
