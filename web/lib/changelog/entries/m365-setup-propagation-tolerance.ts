import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-propagation-tolerance",
  date: "2026-07-20",
  time: "09:30",
  title: "M365 auto-setup: tolerate Entra propagation + clearer progress",
  items: [
    "A newly issued app-registration client secret that fails Entra's live probe with a propagation-class error (invalid_client/unauthorized_client/AADSTS700016/AADSTS7000215, or a network blip) is now retried with backoff for ~90s before giving up — a brand-new app registration can take a couple minutes to propagate",
    "If it still can't be verified after that window, the credential is vaulted anyway with a warning rather than refused — a Graph-issued secret is real, and refusing to vault it stranded a perfectly good credential (the prior behavior)",
    "The per-client setup status route no longer returns a null run during the brief race between a run starting and its per-client row being created, so the UI poller doesn't stop prematurely",
    "The \"Set up M365 automatically\" button now shows its current stage (requesting a device code, signing in, provisioning the app, vaulting the credential) and keeps polling after a page refresh whenever the loaded state is still running or pending",
  ],
};
