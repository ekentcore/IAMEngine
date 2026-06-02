// Renders the Adobe UMAPI v2 action calls Coretelligent.Adobe intends to run (mirrors
// runner/modules/Coretelligent.Adobe). Pure string templating; no side effects.
import { psArray, resolveUpn, type PreviewUser } from "./preview-helpers";

type AdobeConfig = { productProfiles?: string[] };

export function previewAdobe(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  const cfg = (config ?? {}) as AdobeConfig;
  const email = resolveUpn(user, "<UM case>");
  if (action === "offboard") {
    return [
      `$Email = "${email}"`,
      "",
      "# --- intended automation (Coretelligent.Adobe — idempotent) ---",
      "# remove the user from the organization (revokes all product access)",
      `Invoke-CtgAdobeAction -Commands @(@{ user = $Email; do = @(@{ removeFromOrg = @{} }) })`,
    ].join("\n");
  }
  return [
    `$Email    = "${email}"`,
    `$Profiles = ${psArray(cfg.productProfiles)}`,
    "",
    "# --- intended automation (Coretelligent.Adobe — idempotent) ---",
    "# add the user to the configured product profile(s) (which grants the product)",
    `Invoke-CtgAdobeAction -Commands @(@{ user = $Email; do = @(@{ add = @{ product = $Profiles } }) })`,
  ].join("\n");
}
