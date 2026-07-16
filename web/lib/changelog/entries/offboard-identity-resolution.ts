import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-identity-resolution",
  date: "2026-07-14",
  time: "13:30",
  title: "Offboards were failing (and, worse, quietly doing nothing) because the leaver was only ever a name",
  items: [
    "An offboard case reached the runner carrying the departing person as a NAME ('Parth Shah') and nothing else - no email, no UPN. The 365 step died on it with 'The property UserPrincipalName cannot be found on this object' (UM0029766). 15 of the 24 runner modules had the identical bug on their offboard path, so the same case would have failed again at Exchange, AD, Spanning, Slack, Duo, Mimecast, Adobe, Google, Egnyte, Perimeter81, KnowBe4, LogicMonitor, HubSpot and Jira",
    "ServiceNow now resolves the leaver's actual EMAIL from the contact record on the ticket (the same lookup already used for the manager and the mirror user), so every offboard step matches on an email instead of guessing at a display name that is often spelled differently in 365 than in ServiceNow",
    "The nastier half of this: Active Directory and Exchange did NOT crash - they looked for a field the case never had, found nothing, and reported the step as 'ok, no user identity on the case' while the account stayed live. An offboard that reports success without disabling anything is the worst way for this to fail, so a step that cannot identify WHO to offboard now fails loudly instead of going green",
    "The verify pass had the same bug and it was the more dangerous one: the validators run on the same payload, so they crashed too - and where they did not crash, a blank email matched nobody, which reads as 'already gone' and would have rubber-stamped an offboard nobody performed. Unresolvable is now an explicit fail, never a pass",
    "Existing 365 / Exchange / AD cases run without being re-imported (they fall back to the name on the ticket and resolve it against the live directory). The email-keyed SaaS steps - Slack, Duo, Adobe, Spanning and the rest - can only match on an email, so a case that predates this change needs a re-import (or the email set on the case) before those steps will run",
  ],
};
