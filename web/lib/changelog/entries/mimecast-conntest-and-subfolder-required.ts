import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-conntest-and-subfolder-required",
  date: "2026-07-21",
  time: "14:45",
  title: "Mimecast 'Test connections' stops false-flagging a permissioned app; in-app secrets always vault into a subfolder",
  items: [
    "Mimecast connection test: the user-read probe (get-profile for postmaster@) treated Mimecast's per-address 'Forbidden To Perform Operation For Address' as a permission gap, so a correctly permissioned API 2.0 app failed the whole test as FORBIDDEN. It now distinguishes that benign per-address response from a genuine app_forbidden (missing User & Group Management), matching what onboarding actually does",
    "Create in Delinea: authoring a credential in-app now REFUSES to write to the client's ROOT folder — if the client's folder has no 'Identity Services' subfolder it returns an actionable error telling the operator to create it, rather than vaulting somewhere the team can't view",
    "The M365/Google auto-setup writers keep falling back to the client folder (so an in-flight provisioning run is never hard-blocked); only the interactive create path is strict",
    "Runner 1.83.0 — needs deploy. New Test-CtgMimecastPermissionForbidden classifier is unit-tested (29/29 Mimecast Pester tests green)",
  ],
};
