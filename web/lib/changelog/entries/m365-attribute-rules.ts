import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-attribute-rules",
  date: "2026-08-17",
  time: "12:00",
  title: "Attribute rules now actually apply on the Microsoft 365 lane",
  items: [
    "Attributes you configure with roles & rules (title, department, office, address…) are now written to the 365 account. Previously the 365 step built a fixed list of fields from the ticket and never read your attribute rules at all, so anything you configured for a cloud client was silently ignored",
    "Attribute names are translated to what Graph expects, so the names already in your clients' configs keep working with nothing to re-enter — title, mobile, company and physicalDeliveryOfficeName all land correctly",
    "Where a rule and the ticket disagree, the RULE wins and the run report says so — e.g. \"JobTitle = 'Analyst' (rule) overrode 'Engineer' (ticket)\"",
    "An attribute 365 cannot write (extensionAttribute4, proxyAddresses, ipPhone…) is now named in the run report as skipped, instead of disappearing without a word — those stay mastered by Active Directory",
    "A manager set as a rule now applies in 365 too. The ticket still wins when it names one: a ticket knows this specific hire's manager, a client-wide rule doesn't",
    "Offboard attribute rules (offboardAttributes) now apply on the 365 lane as well — they previously only worked on the Active Directory lane",
    "Closes feature requests #0000104 and #0000087, which were the same defect reported twice",
  ],
};
