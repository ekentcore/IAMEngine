// Renders the Egnyte User Management API v2 calls Coretelligent.Egnyte intends to run (mirrors
// runner/modules/Coretelligent.Egnyte). Pure string templating; no side effects.
import { resolveUpn, type PreviewUser } from "./preview-helpers";

type EgnyteConfig = { userType?: string; authType?: string; sendInvite?: boolean; delete?: boolean };

export function previewEgnyte(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as EgnyteConfig;
  const upn = resolveUpn(user, "<UM case>");
  if (action === "offboard") {
    const lines = [
      `$Email = "${upn}"`,
      "",
      "# --- intended automation (Coretelligent.Egnyte — idempotent) ---",
      `$found = Find-CtgEgnyteUser -Email $Email   # GET /pubapi/v2/users?filter=email eq "..."`,
    ];
    if (cfg.delete) {
      lines.push("# config delete=true: remove the account entirely", `Invoke-CtgEgnyteApi -Method DELETE -Path "/pubapi/v2/users/$($found.id)"`);
    } else {
      lines.push("# retention-safe default: deactivate (account + files stay)", `Invoke-CtgEgnyteApi -Method PATCH -Path "/pubapi/v2/users/$($found.id)" -Body @{ active = $false }`);
    }
    return lines.join("\n");
  }
  const userType = (cfg.userType ?? "power").toLowerCase();
  const authType = (cfg.authType ?? "egnyte").toLowerCase();
  return [
    `$Email = "${upn}"`,
    "",
    "# --- intended automation (Coretelligent.Egnyte — idempotent) ---",
    `Find-CtgEgnyteUser -Email $Email   # skip if the user already exists`,
    `# create the user — ${userType} license, ${authType} auth${cfg.sendInvite === false ? "" : ", invite email sent"}`,
    `Invoke-CtgEgnyteApi -Method POST -Path '/pubapi/v2/users' -Body @{`,
    `  userName = '<from email>'; email = $Email; name = @{ givenName = '<first>'; familyName = '<last>' }`,
    `  active = $true; sendInvite = $${cfg.sendInvite === false ? "false" : "true"}; authType = '${authType}'; userType = '${userType}'`,
    `}`,
  ].join("\n");
}
