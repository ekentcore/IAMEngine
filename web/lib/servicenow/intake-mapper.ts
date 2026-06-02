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
const yes = (r: SnUserMgmtRecord, k: string): boolean => (val(r, k) ?? "").toLowerCase() === "yes";
const trimmed = (s: string | null): string | null => (s ? s.trim() : null);
// SN datetimes come as "2026-06-15 19:34:29"; keep the date.
const dateOnly = (s: string | null): string | null => (s ? s.split(" ")[0] : null);

// Reference / glide_list fields hold sys_ids in `value` but readable names in `display_value`
// (SN joins lists with ", "). Always surface the names, as an array.
const dispList = (r: SnUserMgmtRecord, k: string): string[] => {
  const d = disp(r, k);
  return d ? d.split(", ").map((s) => s.trim()).filter(Boolean) : [];
};
// Some fields exist as both a base and a "_uc" twin; take the first that has values.
const firstList = (r: SnUserMgmtRecord, ...keys: string[]): string[] => {
  for (const k of keys) {
    const l = dispList(r, k);
    if (l.length) return l;
  }
  return [];
};

// Office-location display ("United States") -> M365 UsageLocation (ISO-3166 alpha-2). Default US.
const COUNTRY_TO_ISO2: Record<string, string> = {
  "united states": "US", "united states of america": "US", "usa": "US",
  "canada": "CA", "united kingdom": "GB", "uk": "GB", "ireland": "IE",
  "australia": "AU", "india": "IN", "singapore": "SG", "germany": "DE",
  "france": "FR", "spain": "ES", "netherlands": "NL", "mexico": "MX",
};
function deriveUsageLocation(officeLocation: string | null): string {
  if (!officeLocation) return "US";
  const m = officeLocation.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(m)) return m.toUpperCase(); // already a code
  return COUNTRY_TO_ISO2[m] ?? "US";
}

function deriveAction(r: SnUserMgmtRecord): IntakeAction {
  // The coded subcategory value is the authoritative signal: 30000 = User Onboarding,
  // 30100 = User Offboarding (category 1 = Access/Identity). Confirmed live on UM tickets.
  const subVal = val(r, "subcategory") ?? "";
  if (subVal === "30100") return "offboard";
  if (subVal === "30000") return "onboard";
  // Fallback for tickets lacking the coded value: match the display text / short description.
  const sub = (disp(r, "subcategory") ?? "").toLowerCase();
  const short = (val(r, "short_description") ?? "").toLowerCase();
  if (sub.includes("offboard") || short.includes("offboard")) return "offboard";
  return "onboard";
}

function onboardPayload(r: SnUserMgmtRecord): Record<string, unknown> {
  const firstName = trimmed(val(r, "u_first"));
  const lastName = trimmed(val(r, "u_last"));
  const title = val(r, "u_title");
  const officeLocation = disp(r, "u_office_location");
  return {
    // person
    firstName,
    lastName,
    mi: trimmed(val(r, "u_mi")),
    // canonical identity fields the Coretelligent.* modules read (PowerShell access is
    // case-insensitive, so e.g. $User.JobTitle resolves these). UserPrincipalName /
    // SamAccountName / PrimaryDomain are filled by deriveIdentity() once the client is known.
    displayName: [firstName, lastName].filter(Boolean).join(" ") || null,
    jobTitle: title,
    mobilePhone: val(r, "u_personal_phone"),
    usageLocation: deriveUsageLocation(officeLocation),
    startDate: dateOnly(val(r, "u_start_date")),
    isRehire: yes(r, "u_is_this_a_re_hire"),
    newOrExisting: disp(r, "u_new_or_existing"),
    employmentType: disp(r, "u_employment_type") ?? val(r, "u_employment_type"),
    otherEmploymentType: val(r, "u_other_employment_type"),
    title,
    department: val(r, "u_department"),
    managerName: disp(r, "u_manager_name"), // readable name, not sys_id
    officeLocation,
    personalEmail: val(r, "u_personal_email"),
    personalPhone: val(r, "u_personal_phone"),
    homeAddress: val(r, "u_home_address"),
    timezone: disp(r, "u_new_contact_time_zone") ?? val(r, "contact_time_zone"),
    isPrimaryWorkspaceWfh: yes(r, "u_is_their_primary_workspace_wfh"),
    hasDirectReports: yes(r, "u_will_this_individual_have_direct_reports"),
    directReports: dispList(r, "u_who_are_direct_reports"),
    mirrorPermissionsFromUser: disp(r, "u_mirror_existing_user"),
    roles: dispList(r, "u_role_s"),
    listMembership: dispList(r, "u_coretelligent_list_membership"),
    requestedBy: disp(r, "opened_by"),
    // access / licensing (names, not sys_ids)
    emailAddressNeeded: yes(r, "u_email_address_needed"),
    officeLineRequired: yes(r, "u_office_line_required"),
    cellPhoneRequired: yes(r, "u_cell_phone_line_required"),
    productLicenses: dispList(r, "u_product_licenses"),
    securityGroups: dispList(r, "u_security_groups_uc"),
    emailDistroGroups: firstList(r, "u_email_distro_groups_uc", "u_email_distro_groups"),
    sharedMailboxes: firstList(r, "u_shared_resource_mailboxes_uc", "u_shared_resource_mailboxes"),
    otherUnlistedMailbox: val(r, "u_other_unlisted_mailbox"),
    fileShareAccess: firstList(r, "u_what_shares_should_they_have_access_to", "u_shared_drive_access_uc"),
    cloudApplications: firstList(r, "u_cloud_applications_uc", "u_cloud_applications"),
    otherCloudApps: val(r, "u_other_cloud_application_needs"),
    // hardware / software
    clientProvidingAsset: yes(r, "u_client_providing_asset"),
    needsComputer: yes(r, "u_computer_needed"),
    printers: val(r, "u_printer_s_needed"),
    monitors: val(r, "u_monitors_needed"),
    monitorStands: yes(r, "u_monitor_stand_s_needed"),
    keyboardMouse: yes(r, "u_keyboard_mouse_combo"),
    dockingStation: yes(r, "u_docking_station_needed"),
    otherHardware: firstList(r, "u_other_hardware_needed_uc", "u_other_hardware_opt_needed"),
    installedSoftware: firstList(r, "u_installed_software_uc", "u_installed_software"),
    otherSoftware: val(r, "u_other_software_needs"),
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

// --- identity derivation (needs the client's username pattern + domain) -------------------

const cleanToken = (s: string): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Apply a profile username pattern ({first}{last}@{domain}, {first}.{last}@{domain},
// {firstInitial}{last}@{domain}, …) to a person. The local part is lowercased + de-spaced;
// the domain is kept verbatim. Unknown tokens are left as-is for a reviewer to spot.
export function applyUsernamePattern(
  pattern: string,
  vals: { first: string; last: string; mi?: string; domain: string }
): string {
  const f = cleanToken(vals.first);
  const l = cleanToken(vals.last);
  const m = cleanToken(vals.mi ?? "");
  const map: Record<string, string> = {
    "{first}": f, "{last}": l, "{mi}": m,
    "{firstinitial}": f.slice(0, 1), "{lastinitial}": l.slice(0, 1),
    "{f}": f.slice(0, 1), "{l}": l.slice(0, 1),
    "{domain}": vals.domain ?? "",
  };
  return pattern.replace(/\{[a-zA-Z]+\}/g, (tok) => (tok.toLowerCase() in map ? map[tok.toLowerCase()] : tok));
}

// Fill the username-derived identity fields (UPN, SamAccountName, …) onto an onboard payload,
// using the client's username pattern + primary domain. Returns a NEW merged payload; also
// attaches templateFields for the email-template (.eml) variables.
export function deriveIdentity(
  payload: Record<string, unknown>,
  opts: { usernamePatterns?: string[] | null; primaryDomain?: string | null }
): Record<string, unknown> {
  const first = String(payload.firstName ?? "");
  const last = String(payload.lastName ?? "");
  const mi = String(payload.mi ?? "");
  const domain = (opts.primaryDomain ?? "").trim().toLowerCase();
  const pattern = opts.usernamePatterns?.[0] || "{first}.{last}@{domain}";

  // Build the local part from the pattern's left-of-@ portion so a missing domain still yields
  // a SamAccountName (the UPN/work email need a domain).
  const localPattern = pattern.split("@")[0];
  const localPart = applyUsernamePattern(localPattern, { first, last, mi, domain: "" });
  const upn = domain && localPart ? `${localPart}@${domain}` : null;
  const displayName = (payload.displayName as string) || [first, last].filter(Boolean).join(" ") || null;

  const merged = {
    ...payload,
    displayName,
    userPrincipalName: upn,
    samAccountName: localPart || null,
    mailNickname: localPart || null,
    primaryDomain: domain || null,
    workEmail: upn,
  };
  return { ...merged, templateFields: emailTemplateFields(merged) };
}

// Map an onboard payload onto the email-template (.eml) variable labels — the fields a UM
// case fills in the helpdesk email (e.g. LogicSource's OneMarket template).
export function emailTemplateFields(payload: Record<string, unknown>): Record<string, string | null> {
  const s = (k: string): string | null => {
    const v = payload[k];
    return v == null || v === "" ? null : String(v);
  };
  return {
    "Name": s("displayName"),
    "Title": s("jobTitle") ?? s("title"),
    "Department": s("department"),
    "Location": s("officeLocation"),
    "Reports to": s("managerName"),
    "Start Date": s("startDate"),
    "Personal Email": s("personalEmail"),
    "Work Email": s("workEmail") ?? s("userPrincipalName"),
  };
}
