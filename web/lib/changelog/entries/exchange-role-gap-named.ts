import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exchange-role-gap-named",
  date: "2026-09-22",
  time: "18:00",
  title: "Exchange: a cmdlet missing after connecting is explained, and caught by Test connections (runner 1.132.0)",
  items: [
    "When an Exchange step fails with a cmdlet \"not recognized\" (e.g. Get-MailboxStatistics) after Exchange Online connected, the step no longer tries to install a module that is already installed - it explains the two causes: the app's Exchange role doesn't include the cmdlet, or (if the app already has Exchange Administrator) the runner's Exchange session didn't load fully, which a runner restart fixes",
    "Test connections now checks every Exchange Online cmdlet the onboard and offboard steps use, and fails with the list of any that are missing - so the problem shows up on the client page, not halfway through an offboard",
    "Test connections no longer reports the Exchange Administrator role as confirmed just because the connection succeeded",
  ],
};
