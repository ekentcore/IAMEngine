// Common M365 license display-names + username-pattern tokens, offered as autocomplete suggestions
// wherever an operator hand-edits a license or username (the client license editor, the runbook step
// editor). Free text is always allowed — these are just suggestions. The runner resolves a name to a
// tenant SKU (Resolve-CtgSkuId / LicenseSkuMap), so any name/SKU the tenant owns works too.
export const COMMON_LICENSES = [
  "Office 365 E1", "Office 365 E3", "Office 365 E5",
  "Microsoft 365 Business Basic", "Microsoft 365 Business Standard", "Microsoft 365 Business Premium",
  "Microsoft 365 E3", "Microsoft 365 E5", "Microsoft 365 E3 (no Teams)", "Microsoft 365 F3",
  "Microsoft Entra ID P1", "Microsoft Entra ID P2",
  "Microsoft Defender for Office 365 Plan 1", "Microsoft Defender for Office 365 Plan 2",
  "Exchange Online (Plan 1)", "Exchange Online (Plan 2)",
  "Microsoft Teams Enterprise", "Microsoft Teams Phone Standard", "Microsoft Teams Audio Conferencing",
];

// Username (UPN local-part) conventions, used as suggestions when an operator fixes a username line.
export const COMMON_USERNAME_PATTERNS = [
  "{first}.{last}", "{first}{last}", "{firstInitial}{last}", "{first}.{mi}", "{first}_{last}", "{last}.{first}",
];
