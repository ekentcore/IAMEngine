import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "accepted-failure-case-status",
  date: "2026-07-14",
  time: "17:00",
  title: "A case could say 'failed' on the list while every step inside it read green - and nothing could ever clear it",
  items: [
    "INC0859438 showed 'failed' on the cases list, but opening it showed every step succeeded. Both screens were telling the truth about different things. Two steps (Duo, LogicMonitor) really did fail, and an engineer then hit 'Ignore' on both - which flips a step to verified on the case page, but never touches the underlying job. The badge on the list is derived from the jobs, so it stayed red, and no re-run, re-plan or later success could ever clear it",
    "Ignoring a failure now clears it from the case badge too, and un-ignoring puts it back. The dependency gate already treated an accepted failure as satisfied - the case status was the one place that did not. It is now the single place the badge is derived, so the overlay cannot be forgotten again",
    "The two cases already stuck this way (INC0859438, UM0029695) have been corrected - they now read 'completed' and 'needs manual'",
    "Fixed the failure underneath it as well. Duo and LogicMonitor are done by hand for Coretelligent, so their credentials are marked 'not needed' - but those steps had been planned while a credential still existed, so the engine dispatched them anyway, asked for a credential that was not there, and failed the whole case over work a human was always going to do",
    "A step whose every credential is marked 'not needed' is now demoted to a manual checklist item before it is ever dispatched, with a note saying to do it by hand. It cannot fail a case again",
  ],
};
