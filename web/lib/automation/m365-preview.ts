// Renders the PowerShell/Graph commands the M365 module (runner/modules/Coretelligent.M365)
// intends to run, templated from a client's m365 config + identity. The variables block at
// the top is the per-user input — placeholders now, populated from a pulled UM case later.
// Pure string templating; no side effects.

type M365Config = {
  licenses?: string[];
  groups?: string[];
  alias?: { enabled?: boolean; address?: string } | null;
  blockSignIn?: boolean;
  removeLicense?: unknown;
  removeAllGroups?: boolean;
};

type Identity = {
  usernamePatterns?: string[];
  password?: { minLength?: number; requireUpper?: boolean; requireLower?: boolean; requireNumber?: boolean; requireSpecial?: boolean };
};

const psArray = (xs: string[] | undefined): string =>
  xs && xs.length ? "@(\n" + xs.map((x) => `    "${x}"`).join(",\n") + "\n  )" : "@()";

function upnExpr(identity: Identity, domain: string): string {
  // keep the username tokens ({first}/{firstInitial}/{last}) literal — they're filled per user.
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

export function previewM365(action: "onboard" | "offboard", config: M365Config | null | undefined, identity: Identity | null | undefined, primaryDomain: string): string {
  const cfg = config ?? {};
  const id = identity ?? {};
  if (action === "offboard") return offboard(cfg, id, primaryDomain);
  return onboard(cfg, id, primaryDomain);
}

function onboard(config: M365Config, identity: Identity, domain: string): string {
  const lines = [
    "# --- variables (populated from the UM case later) ---",
    `$FirstName         = "<UM case>"`,
    `$LastName          = "<UM case>"`,
    `$UserPrincipalName = "${upnExpr(identity, domain)}"   # from $FirstName / $LastName`,
    `$JobTitle          = "<UM case>"`,
    `$MobilePhone       = "<UM case>"`,
    `$UsageLocation     = "US"`,
    `$Licenses          = ${psArray(config.licenses)}`,
    `$Groups            = ${psArray(config.groups)}`,
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

function offboard(config: M365Config, _identity: Identity, _domain: string): string {
  const lines = [
    "# --- variables (populated from the UM case later) ---",
    `$UserPrincipalName = "<UM case: user to offboard>"`,
    "",
    "# --- intended automation (Coretelligent.M365 — idempotent) ---",
    "# block sign-in",
    `Update-MgUser -UserId $UserPrincipalName -AccountEnabled:$false`,
  ];
  if (config.removeAllGroups) {
    lines.push("", "# remove from all groups", `Get-MgUserMemberOf -UserId $UserPrincipalName | ForEach-Object { Remove-MgGroupMemberByRef -GroupId $_.Id -DirectoryObjectId (Get-MgUser -UserId $UserPrincipalName).Id }`);
  }
  if (config.removeLicense) {
    lines.push("", "# reclaim licenses (after mailbox conversion, per ordering rules)", `Set-MgUserLicense -UserId $UserPrincipalName -AddLicenses @() -RemoveLicenses (Get-MgUserLicenseDetail -UserId $UserPrincipalName).SkuId`);
  }
  return lines.join("\n");
}
