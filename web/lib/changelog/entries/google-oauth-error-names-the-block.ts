import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-oauth-error-names-the-block",
  date: "2026-07-21",
  time: "16:00",
  title: "Google auto-setup: the OAuth failure now names why the sign-in was blocked, not just 'no code'",
  items: [
    "When the automatic Google setup couldn't sign in, the run showed 'the OAuth job finished but returned no authorization code' - which reads like the sign-in ran all the way through and just missed the code at the end",
    "It usually didn't: Google blocks the automated browser at the email step ('Couldn't sign you in / this browser may not be secure'), before the Delinea verification code is ever requested",
    "The runner already recorded that reason as a WARN; the app now pulls it into the run error, so you see e.g. 'the Google sign-in did not complete, so no authorization code came back: Google rejected the sign-in: Couldn't sign you in …' plus a pointer to the manual setup",
    "When no reason was recorded, the generic message now says the sign-in never reached the consent redirect (blocked or interrupted) instead of implying it finished",
    "Both messages point at the manual fallback: convert the key at /tools/google-key and create the google-admin secret by hand",
  ],
};
