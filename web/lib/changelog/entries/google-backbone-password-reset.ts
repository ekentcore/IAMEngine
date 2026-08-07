import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-backbone-password-reset",
  date: "2026-08-06",
  time: "16:30",
  title: "Google-backbone clients get their password reset in Google, not Microsoft 365",
  items: [
    "The pre-run \"reset password\" action picked its target from one hardcoded preference list with google-workspace LAST, applied to every client regardless of backbone. A Google client that also runs an M365 lane — common, since Google carries the mail and M365 the Office apps — had its reset land in M365: the operator changed a password in a tenant the user never signs in to, and the real one was never touched. (FR #0000080)",
    "The cloud lanes are now ordered by the client's backbone, so a Google backbone resets in Google and everything else keeps the previous order exactly",
    "Active Directory still wins first, for every backbone, and that is deliberate rather than an oversight: a client running an AD lane is on-prem-mastered, so a reset written to the synced copy above it is refused outright or silently overwritten by the next sync cycle. The backbone reorders the CLOUD lanes among themselves — which is the whole of the reported bug — and never displaces AD",
    "A client with no backbone recorded (roster-only, not yet modelled) behaves exactly as before, so nothing changes for a client the app hasn't been told about",
  ],
};
