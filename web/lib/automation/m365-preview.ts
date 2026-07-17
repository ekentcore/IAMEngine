// Renders the PowerShell/Graph commands the M365 module (runner/modules/Coretelligent.M365)
// intends to run, templated from a client's m365 config + identity. The variables block at
// the top is the per-user input — `<UM case>` placeholders until a planned case supplies a
// resolved `user` payload, then the real values are substituted inline. No side effects.
import { psArray, uval, ulist, resolveUpn, type PreviewUser } from "./preview-helpers";

type M365Config = {
  licenses?: string[];
  groups?: string[];
  alias?: { enabled?: boolean; address?: string } | null;
  blockSignIn?: boolean;
  removeLicense?: unknown;
  removeAllGroups?: boolean;
  // Offboard hardening. All default to ON — only an explicit `false` turns them off, so the preview
  // must mirror that (`!== false`), not treat "absent" as "off".
  revokeSessions?: boolean;
  removeMfaMethods?: boolean;
  removeManager?: boolean;
  // OneDrive offboard (FR #8/#9): delegate injected per-case by the planner; archive target static.
  oneDriveGrantAccessTo?: string | null;
  oneDriveBackup?: { target?: string } | null;
};

type Identity = {
  usernamePatterns?: string[];
  password?: { minLength?: number; requireUpper?: boolean; requireLower?: boolean; requireNumber?: boolean; requireSpecial?: boolean };
};

function upnExpr(identity: Identity, domain: string, user: PreviewUser): string {
  // A planned case carries the resolved UPN; otherwise show the pattern with tokens left literal.
  if (user) return uval(user, "userPrincipalName", uval(user, "workEmail", "<UM case>"));
  const pattern = identity.usernamePatterns?.[0] ?? "{first}{last}@{domain}";
  return pattern.replace("{domain}", domain || "<domain>");
}

function passwordComment(identity: Identity): string {
  const p = identity.password ?? {};
  const rules = [
    p.minLength ? `min ${p.minLength} chars` : "min length",
    p.requireUpper !== false ? "upper" : null,
    p.requireLower !== false ? "lower" : null,
    p.requireNumber !== false ? "number" : null,
    p.requireSpecial !== false ? "special" : null,
  ].filter(Boolean).join(", ");
  return `# generated to policy: ${rules}`;
}

export function previewM365(action: "onboard" | "offboard", config: unknown, identity: unknown, primaryDomain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as M365Config;
  const id = (identity ?? {}) as Identity;
  if (action === "offboard") return offboard(cfg, id, primaryDomain, user);
  return onboard(cfg, id, primaryDomain, user);
}

function onboard(config: M365Config, identity: Identity, domain: string, user: PreviewUser): string {
  // Prefer the resolved per-user licenses/groups (from the planned case) over the client default.
  const licenses = ulist(user, "productLicenses") ?? config.licenses;
  const groups = ulist(user, "securityGroups") ?? config.groups;
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$FirstName         = "${uval(user, "firstName")}"`,
    `$LastName          = "${uval(user, "lastName")}"`,
    `$UserPrincipalName = "${upnExpr(identity, domain, user)}"   # from $FirstName / $LastName`,
    `$JobTitle          = "${uval(user, "jobTitle")}"`,
    `$MobilePhone       = "${uval(user, "mobilePhone")}"`,
    `$UsageLocation     = "${uval(user, "usageLocation", "US")}"`,
    `$Licenses          = ${psArray(licenses)}`,
    `$Groups            = ${psArray(groups)}`,
    "",
    "# --- intended automation (Coretelligent.M365 — idempotent: checks state before changing) ---",
    passwordComment(identity),
    `$pwd = New-CtgCompliantPassword`,
    `New-MgUser -DisplayName "$FirstName $LastName" -UserPrincipalName $UserPrincipalName \``,
    `  -MailNickname $UserPrincipalName.Split("@")[0] -GivenName $FirstName -Surname $LastName \``,
    `  -JobTitle $JobTitle -MobilePhone $MobilePhone -UsageLocation $UsageLocation -AccountEnabled \``,
    `  -PasswordProfile @{ Password = $pwd; ForceChangePasswordNextSignIn = $true }`,
    "",
    "# assign licenses (runner resolves each name -> SkuId; adds only the missing ones)",
    `foreach ($name in $Licenses) { Set-MgUserLicense -UserId $UserPrincipalName -AddLicenses @(@{ SkuId = (Resolve-CtgSkuId $name) }) -RemoveLicenses @() }`,
    "",
    "# add to security / distribution groups (skips if already a member)",
    `foreach ($g in $Groups) { New-MgGroupMember -GroupId (Get-MgGroup -Filter "displayName eq '$g'").Id -DirectoryObjectId (Get-MgUser -UserId $UserPrincipalName).Id }`,
  ];
  if (config.alias?.enabled) {
    lines.push("", "# add the requested email alias (proxy address)", `Update-MgUser -UserId $UserPrincipalName -ProxyAddresses @("smtp:${config.alias.address ?? "<alias>"}")`);
  }
  return lines.join("\n");
}

function offboard(config: M365Config, _identity: Identity, _domain: string, user: PreviewUser): string {
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$UserPrincipalName = "${resolveUpn(user)}"`,
    "",
    "# --- intended automation (Coretelligent.M365 — idempotent) ---",
    "# block sign-in",
    `Update-MgUser -UserId $UserPrincipalName -AccountEnabled:$false`,
  ];
  if (config.revokeSessions !== false) {
    lines.push("", "# revoke active sessions (blocking sign-in does NOT invalidate tokens already issued)", `Revoke-MgUserSignInSession -UserId $UserPrincipalName`);
  }
  if (config.removeMfaMethods !== false) {
    lines.push(
      "",
      "# remove the registered second factors (they go live again if the account is ever re-enabled,",
      "# and stay usable for self-service password reset). The password method cannot be removed.",
      `Get-MgUserAuthenticationMethod -UserId $UserPrincipalName | Where-Object { $_.AdditionalProperties['@odata.type'] -ne '#microsoft.graph.passwordAuthenticationMethod' } | ForEach-Object { <# Remove-MgUserAuthentication<Type>Method per method type #> }`
    );
  }
  if (config.removeManager !== false) {
    lines.push("", "# clear the manager link (AD-synced users: the AD step clears it on-prem instead)", `Remove-MgUserManagerByRef -UserId $UserPrincipalName`);
  }
  if (config.removeAllGroups) {
    lines.push("", "# remove from all groups", `Get-MgUserMemberOf -UserId $UserPrincipalName | ForEach-Object { Remove-MgGroupMemberByRef -GroupId $_.Id -DirectoryObjectId (Get-MgUser -UserId $UserPrincipalName).Id }`);
  }
  if (config.oneDriveGrantAccessTo) {
    lines.push("", "# grant the case-requested delegate access to the whole OneDrive (name resolved at run time)", `POST /drives/<leaver's drive>/items/root/invite { recipients: ["${config.oneDriveGrantAccessTo}"], roles: ["write"] }`);
  }
  if (config.oneDriveBackup?.target) {
    lines.push("", `# archive the OneDrive into 'Archive - <name>' on ${config.oneDriveBackup.target} (server-side Graph copies; source left for account deletion)`, `POST /drives/<leaver's drive>/items/<each root item>/copy { parentReference: <target drive> }`);
  }
  if (config.removeLicense) {
    lines.push("", "# reclaim licenses (after mailbox conversion, per ordering rules)", `Set-MgUserLicense -UserId $UserPrincipalName -AddLicenses @() -RemoveLicenses (Get-MgUserLicenseDetail -UserId $UserPrincipalName).SkuId`);
  }
  return lines.join("\n");
}
