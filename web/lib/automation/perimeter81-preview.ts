// Renders the Perimeter 81 (Check Point Harmony SASE) API calls Coretelligent.Perimeter81
// intends to run (mirrors runner/modules/Coretelligent.Perimeter81). Onboard is group-driven —
// the module does NOT add the user directly. Pure string templating; no side effects.
import { resolveUpn, type PreviewUser } from "./preview-helpers";

type P81Config = { ensureLicenseAvailable?: boolean; procureIfUnavailable?: boolean; removeUser?: boolean; downtickLicense?: boolean };

export function previewPerimeter81(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as P81Config;
  if (action === "offboard") {
    return [
      `$Email = "${resolveUpn(user, "<UM case>")}"`,
      "",
      "# --- intended automation (Coretelligent.Perimeter81 — idempotent) ---",
      "# find the user by email, then remove them (frees the seat). No-op if absent.",
      `$found = Find-CtgP81User -Email $Email`,
      `if ($found) { Invoke-CtgP81Api -Method DELETE -Path "/api/v1/users/$($found.id)" }`,
    ].join("\n");
  }
  const lines = [
    "# --- intended automation (Coretelligent.Perimeter81 — group-driven onboard) ---",
    "# membership is granted by group/AD sync — the user is NOT added directly here.",
  ];
  if (cfg.ensureLicenseAvailable) lines.push("# verify license headroom", `Invoke-CtgP81Api -Method GET -Path '/api/v1/licenses'`);
  return lines.join("\n");
}
