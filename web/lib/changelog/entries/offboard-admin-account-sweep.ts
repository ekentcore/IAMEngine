import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-admin-account-sweep",
  date: "2026-07-24",
  time: "16:00",
  title: "Coretelligent offboards now check for the person's -a admin account and disable it too",
  items: [
    "Coretelligent engineers hold a privileged secondary account named <sam>-a (mgallegos -> mgallegos-a). Until now an offboard disabled only the primary account and the -a account stayed live",
    "The AD, Exchange and Entra offboard steps now derive the -a identity from the account they just resolved and, when it exists, run the same disable path on it - AD disable + password reset + group strip + OU move, Entra sign-in block + session revoke + MFA removal + device disable, Exchange GAL hide + ActiveSync/OWA block",
    "The check is exact (no fuzzy matching), so a person without a -a account just gets a plain 'no <sam>-a - nothing extra to disable' note and the case never pauses over it",
    "Mail-continuity and license steps (shared-mailbox convert, delegates, out-of-office, license removal, OneDrive archive) stay with the primary account only - the -a pass can never park a case on a mailbox decision",
    "Driven by a new adminAccountSuffix key on the offboard lane config, so any client with the same convention can turn it on; wired for Coretelligent in the profile and the offboard wiring script (runner 1.100.0 + re-wire + re-plan of open cases to take effect)",
  ],
};
