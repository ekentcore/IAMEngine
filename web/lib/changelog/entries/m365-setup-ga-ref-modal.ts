import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-ga-ref-modal",
  date: "2026-07-20",
  time: "09:00",
  title: "Set up M365 without storing the Global Admin login",
  items: [
    "\"Set up M365 automatically\" now opens a small modal asking for the Global Admin login's Delinea secret ID instead of requiring one to already be wired to the client",
    "The reference is used once, for this run only, via the case's secretOverrides — the runner's device-code sign-in brokers the login directly from Delinea",
    "Nothing is ever persisted on the client: after setup finishes, the client only carries the app registration's own m365-admin cert credential",
    "The fleet-wide sweep is unchanged and still relies on a stored m365-global-admin secret",
  ],
};
