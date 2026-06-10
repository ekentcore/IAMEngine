// Renders the Spanning Backup (Microsoft 365) API calls Coretelligent.Spanning intends to run
// (mirrors runner/modules/Coretelligent.Spanning). Onboard assigns a STANDARD backup license;
// offboard retains the backup and swaps to ARCHIVE (data is never deleted). Pure string
// templating; no side effects.
import { resolveUpn, type PreviewUser } from "./preview-helpers";

type SpanningConfig = {
  assignLicense?: boolean;
  procureIfUnavailable?: boolean;
  removeLicense?: boolean;
  unassign?: boolean;
  swapLicense?: { from?: string; to?: string };
};

export function previewSpanning(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as SpanningConfig;
  const upn = resolveUpn(user, "<UM case>");
  if (action === "offboard") {
    const lines = [
      `$Email = "${upn}"`,
      "",
      "# --- intended automation (Coretelligent.Spanning — idempotent, never deletes backups) ---",
      "# read the user's current license state; no-op if they were never in Spanning",
      `$found = Find-CtgSpanningUser -Email $Email   # GET /users/{email}`,
    ];
    if (cfg.removeLicense || cfg.unassign) {
      lines.push(
        "# unassign the license entirely (frees the seat); backups are retained by Spanning",
        `Invoke-CtgSpanningApi -Method POST -Path '/users/unassign' -Body @{ userPrincipalNames = @($Email) }`
      );
    } else {
      const to = cfg.swapLicense?.to ?? "Archive";
      lines.push(
        `# retain the backup as an archive: swap to the ${to} license tier`,
        `Set-CtgSpanningLicense -Email $Email -LicenseType 'ARCHIVE'   # POST /users/assign`
      );
    }
    return lines.join("\n");
  }
  if (cfg.assignLicense === false) {
    return [
      "# --- intended automation (Coretelligent.Spanning) ---",
      "# assignLicense is disabled in this client's config — no backup license is assigned.",
    ].join("\n");
  }
  return [
    `$Email = "${upn}"`,
    "",
    "# --- intended automation (Coretelligent.Spanning — idempotent) ---",
    "# Spanning discovers M365 users on its own schedule; if the user isn't visible yet the",
    "# step exits cleanly and is re-run after the next sync.",
    `$found = Find-CtgSpanningUser -Email $Email   # GET /users/{email}`,
    "# assign a Standard backup license (skipped if already licensed)",
    `Set-CtgSpanningLicense -Email $Email -LicenseType 'STANDARD'   # POST /users/assign`,
    ...(cfg.procureIfUnavailable
      ? ["# on an out-of-seats error: warn to open a Procurement Case instead of failing the step"]
      : []),
  ].join("\n");
}
