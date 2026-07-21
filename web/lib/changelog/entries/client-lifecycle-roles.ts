import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "client-lifecycle-roles",
  date: "2026-07-21",
  time: "17:15",
  title: "New roles: Client onboarding & Client offboarding, with archiving locked down",
  items: [
    "Two RBAC roles: Client onboarding (add, modify, and set up clients — edit systems + wire credentials — plus read-only case visibility, but cannot run cases) and Client offboarding (same, plus archiving clients)",
    "Archiving a client is now its own capability (client.archive): only Client offboarding, Global admin, and Super admin can archive or restore — an ops manager can still edit a client but no longer archive it",
    "The archive/restore icon is hidden for roles that can't archive (the server enforces it regardless), and both roles appear in the “What can each role do?” guide on /users and /users/v2",
    "The three per-client action icons now stack vertically so they fit the row better",
  ],
};
