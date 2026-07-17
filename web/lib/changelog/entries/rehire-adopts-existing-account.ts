import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "rehire-adopts-existing-account",
  date: "2026-07-16",
  time: "22:15",
  title: "Re-hires adopt their old account instead of pausing the case to ask",
  items: [
    'When the intake says "Is this a Re-Hire = Yes", finding the person\'s old account is the expected outcome — but the flag drove nothing, so every re-hire parked at a username-collision decision (or worse, minted a fallback username). (FR #0000003)',
    "Rehire cases now plan the M365/Entra step with the adopt policy: the existing account is enabled, stamped, and reconciled to the new hire's details. (AD and Google already adopt a name-matched account on their own — no default needed there, and \"adopt\" for them is the operator's force override.)",
    "Safety unchanged: adoption only ever happens when the existing account's name matches the hire (legal-vs-nickname aware) — a different person's account still routes to the fallback-username path, and an explicit client or operator policy wins over the default.",
  ],
};
