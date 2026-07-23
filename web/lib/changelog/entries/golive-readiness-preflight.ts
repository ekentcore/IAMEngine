import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "golive-readiness-preflight",
  date: "2026-07-23",
  time: "00:30",
  title: "New Go-live readiness preflight — one GO / NO-GO verdict before the first real Azure case",
  items: [
    "Added a read-only Go-live readiness page at /golive (More → Reference → Go-live readiness) that pulls every readiness signal you used to check across five separate screens — /health integrations, the fleet M365 credential sweep, per-client credential wiring + connection tests, agent online/build state, and backups — into one report with a single top-line GO / GO WITH WARNINGS / NO-GO verdict",
    "Each check shows a pass/warn/fail chip, a plain-English detail line, and (on warn/fail) an actionable remediation hint; the banner tallies blocking failures, warnings, and clients-not-ready, and shows the age of the last M365 sweep so you can see how fresh the credential picture is",
    "Two go-live-specific checks that had no existing surface: whether the database migrations match the deployed code (a cheap read of the migrations table vs the shipped migration files — the exact failure an Azure deploy can produce), and whether the agents have converged on the new app URL (inert on a normal day; a hard gate during a cutover window)",
    "The overall verdict is NO-GO on any blocking failure (database, Delinea, central runner offline, no agent on the current build, migrations out of sync, agents not converged on the URL, or an on-prem client with no reachable agent); a non-blocking problem (e.g. ServiceNow down, stale backup) degrades to GO WITH WARNINGS rather than blocking",
    "Strictly read-only: the page dispatches nothing when it loads — cheap signals are checked live, and the async M365 sweep is read from its last cached result. A fresh sweep (a real Graph sign-in per client) is an explicit \"Run fresh M365 sweep\" button that reuses the existing fleet M365 tool; \"Re-run checks\" re-reads everything without touching a runner",
  ],
};
