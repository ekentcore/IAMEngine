// Renders the Mimecast 2.0 API calls Coretelligent.Mimecast intends to run (mirrors
// runner/modules/Coretelligent.Mimecast). Pure string templating; no side effects.
import { psArray, resolveUpn, type PreviewUser } from "./preview-helpers";

type MimecastConfig = { syncAll?: boolean; verifyInternalDirectory?: string; groups?: string[] };

export function previewMimecast(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as MimecastConfig;
  return action === "offboard" ? offboard(cfg, user) : onboard(cfg);
}

function onboard(config: MimecastConfig): string {
  const lines = ["# --- intended automation (Coretelligent.Mimecast — idempotent) ---"];
  if (config.syncAll) {
    lines.push("# trigger a directory sync so the synced user appears in Mimecast", `Invoke-CtgMimecastApi -Method POST -Path '/directory/cloud-gateway/v1/integrations/sync-requests'`, "");
  }
  if (config.verifyInternalDirectory) {
    const domain = config.verifyInternalDirectory.replace(/^@/, "").toLowerCase();
    lines.push("# verify the client's internal domain is registered + verified", `$domains = Invoke-CtgMimecastApi -Method GET -Path '/domain/cloud-gateway/v1/internal-domains'`, `$domains.data | Where-Object { $_.domain -eq "${domain}" }`);
  }
  if (lines.length === 1) lines.push("# (no sync/verify configured)");
  return lines.join("\n");
}

function offboard(config: MimecastConfig, user: PreviewUser): string {
  const lines = [
    "# --- variables (resolved from the UM case) ---",
    `$Email  = "${resolveUpn(user)}"`,
    `$Groups = ${psArray(config.groups)}`,
    "",
    "# --- intended automation (Coretelligent.Mimecast — idempotent) ---",
    "# remove the user from each configured Mimecast group (mailbox follows the directory account)",
    `foreach ($g in $Groups) { Invoke-CtgMimecastApi -Method POST -Path "/directory/cloud-gateway/v1/groups/$g/remove-members" -Body @{ data = @(@{ emailAddress = $Email }) } }`,
  ];
  return lines.join("\n");
}
