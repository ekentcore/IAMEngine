import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "fleet-audit-perms-and-leaked-seats",
  date: "2026-07-16",
  time: "10:30",
  title: "New page — Fleet audits: which clients are missing a Graph permission, and who is disabled but still holding a licence",
  items: [
    "Fleet audits (in the menu under Reference) answers two questions the per-client pages can't. A client's own permission gaps already show in its connection test; only a fleet sweep can turn that around and tell you WHO needs a given permission",
    "Permissions tab: one row per missing permission, expandable to the clients that need it, with the exact grant command to copy. Until now a gap only surfaced when a step failed on a real case — UM0029796 left a leaver's MFA methods registered, and nobody knew until the offboard warned",
    "Leaked seats tab: disabled users who still hold a licence — leavers we're still paying for. It also reports whether the mailbox was converted, because that decides what's safe: a shared mailbox can have its licence pulled now; a user mailbox must be converted first or Exchange deletes the mail after its 30-day grace",
    "This is the backstop for seats already leaked. This morning's offboard ordering fix only helps future offboards — nothing in the app could see the ones already stranded",
    "A scan takes a few minutes (it reads every client's credential), so it runs in the background with a progress count and the page shows the last finished run. Same data from the command line: `npx tsx scripts/audit-m365-graph-perms.ts --missing UserAuthenticationMethod.ReadWrite.All` and `scripts/audit-leaked-seats.ts` — the page and the scripts run the same sweep, so they can't disagree",
    "A Graph read that fails is reported as \"couldn't verify\", never as \"missing\" — reading ~200 tenants back-to-back is exactly what makes Microsoft throttle, and a report that cries wolf is worse than no report. Those clients are listed separately to re-run, and never counted as a gap",
    "Read-only throughout, and shows permission names only — never a credential value. Visible to anyone who can wire a credential; a restricted operator only sees their own clients",
  ],
};
