// Renders the Admin SDK / Directory API calls Coretelligent.GoogleWorkspace intends to run
// (mirrors runner/modules/Coretelligent.GoogleWorkspace). Pure string templating; no side
// effects. Google is the identity origin for `google`-backbone clients (e.g. Brighton Park)
// and an extra identity on some AD clients. NEVER deletes on offboard — suspend + custody only.
import { psArray, ulist, uval, resolveUpn, type PreviewUser } from "./preview-helpers";

type GoogleConfig = {
  ou?: string;
  conditionalOus?: { when?: string; ou?: string }[];
  groups?: string[];
  license?: { procureIfUnavailable?: boolean } | null;
  domainSelection?: string;
  transferTarget?: string;
  inactiveOu?: string;
  guardrails?: string[];
};

function emailExpr(domain: string, user: PreviewUser): string {
  // A planned case carries the resolved work email / UPN; otherwise show a pattern placeholder.
  if (user) return uval(user, "workEmail", uval(user, "userPrincipalName", "<UM case>"));
  return `{first}{last}@${domain || "<domain>"}`;
}

export function previewGoogleWorkspace(action: "onboard" | "offboard", config: unknown, _identity: unknown, primaryDomain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as GoogleConfig;
  if (action === "offboard") return offboard(cfg, user);
  return onboard(cfg, primaryDomain, user);
}

function onboard(config: GoogleConfig, domain: string, user: PreviewUser): string {
  const groups = ulist(user, "googleGroups") ?? config.groups;
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$PrimaryEmail = "${emailExpr(domain, user)}"`,
    `$FirstName    = "${uval(user, "firstName")}"`,
    `$LastName     = "${uval(user, "lastName")}"`,
    `$Ou           = "${config.ou ?? "/Active Users"}"   # never the Root OU`,
    `$Groups       = ${psArray(groups)}`,
    "",
    "# --- intended automation (Coretelligent.GoogleWorkspace — idempotent: checks state first) ---",
    "# create the user only if they don't already exist (password generated or shared-default)",
    `if (-not (Get-CtgGoogleUser -Email $PrimaryEmail)) {`,
    `  New-CtgGoogleUser -PrimaryEmail $PrimaryEmail -GivenName $FirstName -FamilyName $LastName -Password (New-CtgCompliantPassword) -OrgUnitPath $Ou`,
    `}`,
    "",
    "# place in the target OU (conditional routing: Prialto / MFA / uovo.fashion -> GardeRobe)",
    `Set-CtgGoogleOu -Email $PrimaryEmail -OrgUnitPath $Ou`,
    "",
    "# add group memberships (skips groups the user is already in)",
    `foreach ($g in $Groups) { Add-CtgGoogleGroups -Email $PrimaryEmail -Group $g }`,
  ];
  if (config.license) {
    lines.push("", "# assign license (procure first if none available)", `Set-CtgGoogleLicense -Email $PrimaryEmail -ProcureIfUnavailable:$${config.license.procureIfUnavailable ? "true" : "false"}`);
  }
  lines.push("", "# REQUIRED verification: test mail flow before closing the case", `Test-CtgGoogleMailFlow -Email $PrimaryEmail`);
  return lines.join("\n");
}

function offboard(config: GoogleConfig, user: PreviewUser): string {
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$PrimaryEmail = "${resolveUpn(user, "<UM case: user to offboard>")}"`,
    `$InactiveOu   = "${config.inactiveOu ?? "/Email & Calendar/Inactive"}"`,
    "",
    "# --- intended automation (Coretelligent.GoogleWorkspace — idempotent; NEVER deletes) ---",
    "# no-op if the user isn't present",
    `if (Get-CtgGoogleUser -Email $PrimaryEmail) {`,
    "  # 1. capture evidence FIRST (groups + reset password for the manager) before changing state",
    `  $evidence = Get-CtgGoogleEvidence -Email $PrimaryEmail`,
    "  # 2. reset password, clear recovery info + sign-in cookies",
    `  Reset-CtgGooglePassword -Email $PrimaryEmail`,
    `  Clear-CtgGoogleRecovery -Email $PrimaryEmail`,
    "  # 3. remove group memberships + connected apps + shared-drive access",
    `  Remove-CtgGoogleGroups -Email $PrimaryEmail`,
    "  # 4. move to the Inactive OU (must precede any Drive transfer)",
    `  Set-CtgGoogleOu -Email $PrimaryEmail -OrgUnitPath $InactiveOu`,
  ];
  if (config.transferTarget) {
    lines.push(`  # 5. on request: transfer Drive ownership + calendar events to the delegate`, `  Transfer-CtgGoogleDrive -From $PrimaryEmail -To "${config.transferTarget}"`);
  }
  const wipeGated = (config.guardrails ?? []).includes("no-device-wipe-without-approval");
  lines.push(
    `  # 6. device: ${wipeGated ? "Wipe Account requires approval — Sign Out User otherwise" : "Sign Out User"}`,
    `  Suspend-CtgGoogleUser -Email $PrimaryEmail   # deactivate only; 'archive' module handles deletion later`,
    `}`
  );
  return lines.join("\n");
}
