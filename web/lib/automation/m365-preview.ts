// Renders the PowerShell the M365 executor intends to run, as a parameterized
// script with a variables block on top. This MIRRORS
// runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 (Invoke-CtgM365Onboarding):
// New-MgUser -> Set-MgUserLicense -> New-MgGroupMember -> Update-MgUser (alias),
// idempotent (Get-before-Set). It does not execute anything.
//
// The variables block is populated from the client's profile config (licenses,
// groups, alias) + identity now; the per-user fields are placeholders to be
// filled from a pulled UM case later.
import type { Action } from "@prisma/client";
import type { Identity } from "@/lib/clients/types";

type M365Config = {
  licenses?: string[];
  groups?: string[];
  alias?: string | { address?: string };
  blockSignIn?: boolean;
  removeAllGroups?: boolean;
  [key: string]: unknown;
};

// PowerShell array literal: @("a", "b") or @() when empty.
function psArray(items: string[] | undefined): string {
  if (!items || items.length === 0) return "@()";
  return `@(${items.map((s) => `"${s.replace(/"/g, '`"')}"`).join(", ")})`;
}

function upnTemplate(identity: Identity | null, primaryDomain: string): string {
  const pattern = identity?.usernamePatterns?.[0] ?? "{first}{last}@{domain}";
  return pattern.replace("{domain}", primaryDomain);
}

function onboard(config: M365Config, identity: Identity | null, primaryDomain: string): string {
  const minLength = identity?.password?.minLength ?? 14;
  const forceChange = identity?.password?.requireChangeAtSignIn ?? true;
  const alias = typeof config.alias === "string" ? config.alias : config.alias?.address;

  const lines: string[] = [
    "# --- variables (populated from the UM case later) ---",
    '$FirstName        = "<UM case>"',
    '$LastName         = "<UM case>"',
    '$JobTitle         = "<UM case>"',
    '$MobilePhone      = "<UM case>"',
    '$UsageLocation    = "US"',
    `$UserPrincipalName = "${upnTemplate(identity, primaryDomain)}"   # pattern; {first}/{last} from the case`,
    `$Licenses = ${psArray(config.licenses)}`,
    `$Groups   = ${psArray(config.groups)}`,
    ...(alias ? [`$Alias    = "${alias}"`] : []),
    "",
    "# --- commands (mirror Coretelligent.M365\\Invoke-CtgM365Onboarding; idempotent Get-before-Set) ---",
    "$PasswordProfile = @{",
    `    Password                      = (New-CtgCompliantPassword -MinLength ${minLength})  # policy-compliant`,
    `    ForceChangePasswordNextSignIn = $${forceChange}`,
    "}",
    "New-MgUser -AccountEnabled -DisplayName \"$FirstName $LastName\" `",
    "    -UserPrincipalName $UserPrincipalName -MailNickname ($UserPrincipalName.Split('@')[0]) `",
    "    -GivenName $FirstName -Surname $LastName -JobTitle $JobTitle -MobilePhone $MobilePhone `",
    "    -UsageLocation $UsageLocation -PasswordProfile $PasswordProfile",
    "",
    "# runner resolves each license name to its SkuId, then adds only what's missing",
    "Set-MgUserLicense -UserId $UserPrincipalName -AddLicenses (Resolve-CtgSku $Licenses) -RemoveLicenses @()",
    "",
    "foreach ($g in $Groups) {",
    "    New-MgGroupMember -GroupId (Get-CtgGroupId $g) -DirectoryObjectId $UserId   # skipped if already a member",
    "}",
  ];
  if (alias) {
    lines.push(
      "",
      "Update-MgUser -UserId $UserPrincipalName -ProxyAddresses (@(Get-CtgProxyAddresses) + \"smtp:$Alias\")"
    );
  }
  return lines.join("\n");
}

function offboard(config: M365Config, identity: Identity | null, primaryDomain: string): string {
  const lines: string[] = [
    "# --- variables (populated from the UM case later) ---",
    `$UserPrincipalName = "${upnTemplate(identity, primaryDomain)}"   # the departing user`,
    "",
    "# --- commands (idempotent Get-before-Set) ---",
  ];
  if (config.blockSignIn) lines.push("Update-MgUser -UserId $UserPrincipalName -AccountEnabled:$false   # block sign-in");
  if (config.removeAllGroups) {
    lines.push(
      "foreach ($g in (Get-MgUserMemberOf -UserId $UserPrincipalName)) {",
      "    Remove-MgGroupMemberByRef -GroupId $g.Id -DirectoryObjectId $UserId",
      "}"
    );
  }
  // Surface the remaining offboard config so the preview reflects each client's lane.
  for (const [key, value] of Object.entries(config)) {
    if (key === "blockSignIn" || key === "removeAllGroups") continue;
    lines.push(`# ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

export function previewM365(
  action: Action,
  config: M365Config | null,
  identity: Identity | null,
  primaryDomain: string
): string {
  const cfg = config ?? {};
  return action === "onboard"
    ? onboard(cfg, identity, primaryDomain)
    : offboard(cfg, identity, primaryDomain);
}
