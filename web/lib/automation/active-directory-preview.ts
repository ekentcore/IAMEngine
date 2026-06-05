// Renders the on-prem AD cmdlets Coretelligent.ActiveDirectory intends to run (mirrors
// runner/modules/Coretelligent.ActiveDirectory). Resolved per-user values from a planned case
// are substituted inline. Pure string templating; no side effects.
import { psArray, uval, type PreviewUser } from "./preview-helpers";

type Home = { unc?: string; letter?: string };
type CondGroup = { when?: string; groups?: string[] };
type ADConfig = {
  ou?: string;
  homeDrive?: Home | null;
  attributes?: Record<string, unknown>;
  mirrorFromUser?: string;
  groups?: string[];
  conditionalGroups?: CondGroup[];
  resetPassword?: boolean;
  removeAllGroups?: boolean;
  hideFromGal?: { attribute?: string; value?: string } | null;
  disableAccount?: boolean;
  disabledUsersOu?: string;
  guardrails?: string[];
};

function ouExpr(ou: string | undefined, domain: string): string {
  const dn = (domain || "<domain>").split(".").map((d) => `DC=${d}`).join(",");
  if (!ou) return dn;
  if (/DC=/.test(ou)) return ou;
  if (/^OU=/.test(ou)) return `${ou},${dn}`;
  return `OU=${ou},${dn}`;
}

export function previewActiveDirectory(action: "onboard" | "offboard", config: unknown, _identity: unknown, primaryDomain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as ADConfig;
  return action === "offboard" ? offboard(cfg, primaryDomain, user) : onboard(cfg, primaryDomain, user);
}

function onboard(config: ADConfig, domain: string, user: PreviewUser): string {
  const groups = config.groups ?? [];
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$Sam               = "${uval(user, "samAccountName")}"`,
    `$DisplayName       = "${uval(user, "displayName")}"`,
    `$UserPrincipalName = "${uval(user, "userPrincipalName")}"`,
    `$OuPath            = "${ouExpr(config.ou, domain)}"`,
    "",
    "# --- intended automation (Coretelligent.ActiveDirectory — idempotent) ---",
    "# create the user in the target OU (skips if SamAccountName already exists)",
    `New-ADUser -Name $DisplayName -SamAccountName $Sam -UserPrincipalName $UserPrincipalName \``,
    `  -GivenName "${uval(user, "firstName")}" -Surname "${uval(user, "lastName")}" -DisplayName $DisplayName \``,
    `  -Path $OuPath -Enabled $true -AccountPassword $initial \``,
    `  -OtherAttributes @{ proxyAddresses = "SMTP:$UserPrincipalName" }`,
  ];
  if (config.homeDrive) {
    const unc = (config.homeDrive.unc ?? "<unc>").replace("<username>", "$Sam");
    lines.push("", "# map the home drive", `Set-ADUser -Identity $Sam -HomeDrive "${config.homeDrive.letter ?? "H"}:" -HomeDirectory "${unc}"`);
  }
  const attrs = config.attributes && typeof config.attributes === "object" ? config.attributes : null;
  if (attrs && Object.keys(attrs).length) {
    lines.push("", "# set directory attributes (resolved from the case + persona/globals)",
      `$Attributes = @{`);
    for (const [k, v] of Object.entries(attrs)) lines.push(`  ${k} = "${String(v)}"`);
    lines.push(`}`, `foreach ($a in $Attributes.GetEnumerator()) { Set-ADUser -Identity $Sam -Replace @{ $a.Key = $a.Value } }`);
  }
  lines.push("", "# add to base groups (skips if already a member)", `$Groups = ${psArray(groups)}`, `foreach ($g in $Groups) { Add-ADGroupMember -Identity $g -Members $Sam }`);
  if (config.conditionalGroups?.length) {
    lines.push("", "# conditional groups (added when the rule matches the user):");
    for (const cg of config.conditionalGroups) lines.push(`#   when ${cg.when ?? "?"} -> ${(cg.groups ?? []).join(", ")}`);
  }
  if (config.mirrorFromUser) {
    lines.push("",
      `# mirror — union the LIVE group memberships of "${config.mirrorFromUser}" (resolved at run time)`,
      `$RefGroups = (Get-ADUser -Filter "DisplayName -eq '${config.mirrorFromUser}'" -Properties MemberOf).MemberOf`,
      `foreach ($g in $RefGroups) { Add-ADGroupMember -Identity $g -Members $Sam }`);
  }
  return lines.join("\n");
}

function offboard(config: ADConfig, domain: string, user: PreviewUser): string {
  const lines = [
    user ? "# --- variables (resolved from the UM case) ---" : "# --- variables (populated from the UM case later) ---",
    `$Sam = "${uval(user, "samAccountName", uval(user, "userToOffboard", "<UM case: user to offboard>"))}"`,
    "",
    "# --- intended automation (Coretelligent.ActiveDirectory — idempotent, evidence first) ---",
  ];
  if (config.resetPassword) lines.push("# reset password", `Set-ADAccountPassword -Identity $Sam -Reset -NewPassword $new`, "");
  lines.push("# capture group memberships as evidence BEFORE removing", `$Groups = Get-ADPrincipalGroupMembership -Identity $Sam`);
  if (config.removeAllGroups) lines.push("# remove from all groups (Domain Users is the primary group — skipped)", `foreach ($g in $Groups) { if ($g.Name -ne 'Domain Users') { Remove-ADGroupMember -Identity $g.Name -Members $Sam -Confirm:$false } }`);
  if (config.hideFromGal?.attribute) lines.push("", "# hide from the GAL", `Set-ADUser -Identity $Sam -Replace @{ ${config.hideFromGal.attribute} = "${config.hideFromGal.value ?? "TRUE"}" }`);
  lines.push("", "# clear manager", `Set-ADUser -Identity $Sam -Clear manager`);
  if (config.disableAccount !== false) lines.push("", "# disable the account", `Disable-ADAccount -Identity $Sam`);
  if (config.guardrails?.includes("do-not-move-ou")) {
    lines.push("", "# NOT moved — do-not-move-ou guardrail (moving would delete the synced 365 account)");
  } else if (config.disabledUsersOu) {
    lines.push("", "# move to the Disabled Users OU", `Move-ADObject -Identity $dn -TargetPath "${config.disabledUsersOu}"`);
  }
  return lines.join("\n");
}
