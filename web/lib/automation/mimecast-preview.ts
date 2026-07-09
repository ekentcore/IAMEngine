// Renders the Mimecast API calls Coretelligent.Mimecast intends to run (mirrors
// runner/modules/Coretelligent.Mimecast — classic endpoints served by API 2.0 with Bearer auth).
// Pure string templating; no side effects.
import { psArray, resolveUpn, type PreviewUser } from "./preview-helpers";

type MimecastConfig = { syncAll?: boolean; createIfMissing?: boolean; verifyInternalDirectory?: string; groups?: string[] };

export function previewMimecast(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as MimecastConfig;
  return action === "offboard" ? offboard(cfg, user) : onboard(cfg, user);
}

function onboard(config: MimecastConfig, user?: PreviewUser): string {
  const lines = [
    `$Email = "${resolveUpn(user, "<UM case>")}"`,
    "",
    "# --- intended automation (Coretelligent.Mimecast — idempotent) ---",
    "# verify a directory-sync connection exists, then trigger a sync so the user flows in",
    `Invoke-CtgMimecastApi -Path '/api/directory/get-connection'`,
    `Invoke-CtgMimecastApi -Path '/api/directory/execute-sync'`,
    "# confirm the user's profile is visible",
    `Get-CtgMimecastProfile -Email $Email   # POST /api/user/get-profile`,
  ];
  if (config.createIfMissing) {
    lines.push(
      "# not visible + createIfMissing: create a cloud user in the Internal Directory",
      `Invoke-CtgMimecastApi -Path '/api/user/create-user' -Data @{ emailAddress = $Email; forcePasswordChange = $true }`
    );
  }
  if (config.verifyInternalDirectory) {
    const domain = config.verifyInternalDirectory.replace(/^@/, "").toLowerCase();
    lines.push("# verify the client's internal domain is registered", `Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain'   # expect ${domain}`);
  }
  return lines.join("\n");
}

function offboard(config: MimecastConfig, user?: PreviewUser): string {
  return [
    "# --- variables (resolved from the UM case) ---",
    `$Email  = "${resolveUpn(user)}"`,
    `$Groups = ${psArray(config.groups)}`,
    "",
    "# --- intended automation (Coretelligent.Mimecast — idempotent) ---",
    "# remove the user from each configured Mimecast group (mailbox follows the directory account)",
    `foreach ($g in $Groups) {`,
    `  $id = Find-CtgMimecastGroup -Group $g   # POST /api/directory/find-groups`,
    `  Invoke-CtgMimecastApi -Path '/api/directory/remove-group-member' -Data @{ id = $id; emailAddress = $Email }`,
    `}`,
  ].join("\n");
}
