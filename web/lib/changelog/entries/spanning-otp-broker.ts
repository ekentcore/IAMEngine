import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-otp-broker",
  date: "2026-07-13",
  time: "13:00",
  title: "Spanning force-sync: Delinea-minted MFA codes (PR #24, runner 1.45.0)",
  items: [
    "The Spanning sync login now gets its MFA code minted by Delinea at the exact moment the prompt appears - no authenticator seed is ever stored or handled outside the vault",
    "One automatic retry with a fresh code when a code expires mid-login",
    "Legacy stored-seed secrets keep working as a fallback, with a nudge to enable One-Time Password on the Delinea secret",
  ],
};
