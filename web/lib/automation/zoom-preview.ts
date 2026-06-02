// Renders the Zoom REST API v2 calls Coretelligent.Zoom intends to run (mirrors
// runner/modules/Coretelligent.Zoom). Pure string templating; no side effects.
import { resolveUpn, uval, type PreviewUser } from "./preview-helpers";

type ZoomConfig = { type?: number; action?: string; delete?: boolean };

export function previewZoom(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as ZoomConfig;
  const email = resolveUpn(user, "<UM case>");
  if (action === "offboard") {
    const lines = [
      `$Email = "${email}"`,
      "",
      "# --- intended automation (Coretelligent.Zoom — idempotent) ---",
      "# no-op if the user isn't present",
    ];
    if (cfg.delete) lines.push(`if (Get-CtgZoomUser -Email $Email) { Invoke-CtgZoomApi -Method DELETE -Path "/users/$Email" }`);
    else lines.push(`if (Get-CtgZoomUser -Email $Email) { Invoke-CtgZoomApi -Method PUT -Path "/users/$Email/status" -Body @{ action = 'deactivate' } }`);
    return lines.join("\n");
  }
  return [
    `$Email = "${email}"`,
    "",
    "# --- intended automation (Coretelligent.Zoom — idempotent) ---",
    "# create the user only if they don't already exist",
    `if (-not (Get-CtgZoomUser -Email $Email)) {`,
    `  Invoke-CtgZoomApi -Method POST -Path '/users' -Body @{`,
    `    action    = '${cfg.action ?? "create"}'`,
    `    user_info = @{ email = $Email; type = ${cfg.type ?? 2}; first_name = "${uval(user, "firstName")}"; last_name = "${uval(user, "lastName")}" }`,
    `  }`,
    `}`,
  ].join("\n");
}
