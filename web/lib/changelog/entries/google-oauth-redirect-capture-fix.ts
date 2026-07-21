import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-oauth-redirect-capture-fix",
  date: "2026-07-21",
  time: "07:30",
  title: "Google Workspace auto-setup: the OAuth sign-in now captures the authorization code (first live run fix)",
  items: [
    "THE SYMPTOM: the very first live 'Set up Google Workspace automatically' run (Drive Capital) sailed through the whole sign-in — email, password, one-time code, consent — and then failed with 'the OAuth job finished but returned no authorization code' and a blank screenshot.",
    "THE CAUSE: Google returns the authorization code by 302-redirecting the consent page to a loopback address nothing listens on (by design — the flow reads the code off the request instead of serving it). But the browser follows a server-side redirect at the network layer, where Playwright's route interception never gets a look-in: the hop to 127.0.0.1 failed with connection-refused, the page landed on Chromium's blank error page, and the code — right there in the failed request's URL — was never read.",
    "THE FIX: the flow now listens to the browser's request/request-failed events as the primary capture (the request object carries the full redirect URL, code included, even when the connection is refused), keeping the old route-interception as a secondary for client-side navigations. Proven against the exact URL shape the live run produced.",
    "Ships in runner 1.79.1 — runners self-update on their next heartbeat once the app serves it.",
  ],
};
