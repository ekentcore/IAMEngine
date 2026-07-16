import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "security-p0-runner",
  date: "2026-07-03",
  approx: true,
  title: "Security P0 + runner resilience (week of Jun 30)",
  items: [
    "Auth fail-closed, token hygiene, injection guards, database indexes",
    "Super-admin impersonation (view as another operator, mutations blocked)",
    "Runner 1.29 to 1.31.11: Mac fix, AD/directory-sync fixes, PowerShell 7 compatibility on DCs",
    "Runner supervision (systemd / Windows service / DC), Exchange adaptive routing",
  ],
};
