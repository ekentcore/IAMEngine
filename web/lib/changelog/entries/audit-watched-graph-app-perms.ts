import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "audit-watched-graph-app-perms",
  date: "2026-07-22",
  time: "23:15",
  title: "Fleet audit 'Extra access': surface who holds Application.Read.All alongside AppRoleAssignment.ReadWrite.All",
  items: [
    "The 'Extra access' tab in Fleet audits already listed who holds escalation-capable Graph roles like AppRoleAssignment.ReadWrite.All - it now also lists who holds Application.Read.All, the read-over-all-app-registrations permission",
    "Application.Read.All is treated as a 'watched' role, not escalation: the engine legitimately uses it to warn before its own credential expires, so it stays a needed permission everywhere else (Permissions tab, per-client connection test, the runner's surplus check) and is never reported as surplus",
    "Watched roles show with a muted dot and a 'watched, not surplus' note; escalation roles keep their amber warning and always sort first, so a security review never scrolls past a note to reach a tenant-takeover route",
    "Web-only, read-only, no runner change - the sweep still just reads each client's m365-admin app registration and reports what it holds",
  ],
};
