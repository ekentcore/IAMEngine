import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-auto-setup-usable",
  date: "2026-07-20",
  time: "07:45",
  title: "Automated M365 setup is now usable — one client or the whole fleet",
  items: [
    "A 'Set up M365 automatically' button on each client page provisions its iam-engine app registration end to end: a Global-Admin device-code sign-in runs in a runner browser, then the app registration is created + admin-consented and the credential is written back to Delinea",
    "A fleet-wide sweep on the fleet-audit page sets up every client that has a wired Global-Admin login, with a dry-run that previews who is eligible before anything is created",
    "Clients without an m365-global-admin login secret are skipped with a clear reason, and a failed sign-in (e.g. non-automatable push/SMS MFA) is reported per client rather than silently",
  ],
};
