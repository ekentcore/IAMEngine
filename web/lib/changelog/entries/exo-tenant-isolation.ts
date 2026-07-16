import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "exo-tenant-isolation",
  date: "2026-07-16",
  time: "11:45",
  title: "An Exchange step could connect to ANOTHER client's tenant — Easterseals' offboard authenticated against Olympus Cosmetic's directory",
  items: [
    "Easterseals' offboard (UM0029840) failed with \"Application ... was not found in the directory 'Olympus Cosmetic'\". Nothing was miswired: Easterseals' own credentials were correct and had tested green hours earlier. The runner had simply asked the wrong tenant",
    "The central runner serves the whole fleet from one long-lived process, and a Microsoft Graph sign-in is process-wide — there is only ever one. Olympus Cosmetic's connection tests bound it to Olympus at 15:11. At 15:23 Easterseals' Exchange step needed to know its tenant's mail domain, read it off the session that happened to be loaded, and got olympuscosmetic.com — then sent Easterseals' own app id there",
    "The runner now drops every cloud sign-in the moment the client changes — before anything runs, whether the previous work was a case or a connection test. Each client starts from nothing and signs in as itself, so no step can inherit a session from the client before it. Nothing has to notice it's on the wrong tenant, which is the point: the step that caused this didn't notice",
    "Exchange sessions are now closed when a client's onboard/offboard finishes, including when it fails. They were never closed at all, and Exchange stacks sessions rather than replacing them — so a runner that never restarts would eventually be refused new ones, on every client at once",
    "This was not a transient race: the stale sign-in persisted until something else replaced it, so the same step failed identically 42 minutes later with nothing in between. It needed no re-run and no operator step — it needed this fix",
    "The reverse failure stays fixed: a client whose website domain names a different directory (it happens) is still resolved from its real tenant, not its website. Where we can't reach Graph, an operator-set Domain on the credential now outranks the website domain, which is the value that caused that failure in the first place",
    "Run-log lines now name the client, and the Exchange error now says which of the two faults it is instead of always blaming the app id. Both had sent Fix with AI (and anyone reading the log) after the wrong thing",
  ],
};
