import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-oauth-offline-grant",
  date: "2026-07-21",
  time: "08:15",
  title: "Google Workspace auto-setup: the token exchange now survives Workspace reauth policies (rapt_required)",
  items: [
    "THE SYMPTOM: after the redirect-capture fix, the Drive Capital run got all the way through sign-in and consent — and then the app's code-for-token exchange was refused with invalid_grant (rapt_required), even with the Google Cloud SDK app marked Trusted and 'Exempt trusted apps' set in Google Cloud session control.",
    "THE CAUSE: the consent request asked for access_type=online. Under a Workspace Google Cloud session-control reauthentication policy, an online code redemption is session-bound and Google demands a reauth proof (RAPT) the backend exchange cannot supply — even seconds after a fresh password + one-time-code sign-in. gcloud never hits this because it always requests access_type=offline: the offline redemption is accepted, and the reauth policy instead governs refresh calls.",
    "THE FIX: the consent URL now requests access_type=offline, matching gcloud. The refresh token that comes back is deliberately dropped — never returned, never vaulted — so nothing long-lived survives the run; provisioning still uses only the short-lived access token. Proven live: cold sign-in + offline exchange succeeds on Drive Capital where every online variant was refused.",
    "App-side only — no runner update needed.",
  ],
};
