// Friendly labels for the raw intake payload keys shown on the case page. Unmapped keys fall back to
// a humanized camelCase/snake_case form so a new field is still readable.
export const INTAKE_LABELS: Record<string, string> = {
  firstName: "First name", lastName: "Last name", mi: "Middle initial", displayName: "Display name",
  nickname: "Nickname (goes by)", legalFirstName: "Legal first name",
  jobTitle: "Job title", department: "Department", managerName: "Manager", manager: "Manager",
  employmentType: "Employment type", otherEmploymentType: "Employment type (other)",
  startDate: "Start date", dateOfOffboarding: "Offboarding date",
  isRehire: "Rehire?", newOrExisting: "New or existing",
  mobilePhone: "Mobile phone", usageLocation: "Usage location (M365)", officeLocation: "Office location",
  timezone: "Time zone", personalEmail: "Personal email", personalPhone: "Personal phone", homeAddress: "Home address",
  isPrimaryWorkspaceWfh: "Primarily works from home?", hasDirectReports: "Has direct reports?", directReports: "Direct reports",
  mirrorPermissionsFromUser: "Mirror permissions from", roles: "Roles", role: "Role", listMembership: "List membership",
  requestedBy: "Requested by", emailAddressNeeded: "Email address needed?", officeLineRequired: "Office line required?",
  cellPhoneRequired: "Cell phone required?", productLicenses: "Product licenses", securityGroups: "Security groups",
  extraGroups: "Additional groups",
  emailDistroGroups: "Email distribution groups", sharedMailboxes: "Shared mailboxes", otherUnlistedMailbox: "Other mailbox",
  fileShareAccess: "File share access", cloudApplications: "Cloud applications", otherCloudApps: "Other cloud apps",
  clientProvidingAsset: "Client providing asset?", needsComputer: "Needs computer?", printers: "Printers",
  monitors: "Monitors", monitorStands: "Monitor stands?", keyboardMouse: "Keyboard / mouse?",
  did: "Direct dial (DID)", extension: "Extension",
};

export function intakeLabel(key: string): string {
  const mapped = INTAKE_LABELS[key];
  if (mapped) return mapped;
  // Humanize: insert spaces at camelCase boundaries + underscores, capitalize the first letter.
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}
