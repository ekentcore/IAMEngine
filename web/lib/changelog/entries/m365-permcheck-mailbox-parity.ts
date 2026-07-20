import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-permcheck-mailbox-parity",
  date: "2026-07-20",
  time: "18:15",
  title: "Connection test: a granted MailboxSettings.Read no longer reads as missing",
  items: [
    "MailboxSettings.Read showed red on the connection test even though the tenant HAS it granted (core1787). The permission was fine — the runner's hand-maintained copy of the Graph capability table (Start-IamRunner.ps1) was missing the 'read whether a leaver's mailbox was converted to shared' capability the web table gained, so the surplus scan classified the granted role as 'not needed: MailboxSettings.Read' and the UI rendered that red row as a missing permission.",
    "Added the capability (anyOf: MailboxSettings.Read / MailboxSettings.ReadWrite) to the runner's table — runner 1.78.0, needs the usual runner self-update after deploy.",
    "New parity test: the web suite now reads Start-IamRunner.ps1 and fails if any web capability (its wording or any of its roles) is absent from the runner copy — this drift class can't recur silently.",
  ],
};
