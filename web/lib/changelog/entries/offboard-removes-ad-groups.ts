import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-removes-ad-groups",
  date: "2026-09-04",
  time: "10:00",
  title: "Offboarding now actually removes the leaver's Active Directory groups",
  items: [
    "A departing user was keeping every AD group membership, and the case still reported green. Of 44 AD clients, 2 removed all groups, none had named-group rules, and 42 removed nothing at all. (FR #0000109)",
    "The engine has always known HOW to do this — nothing ever asked it to. No group policy was configured on those clients, and silence was being read as \"keep everything\", which is the wrong default for an offboard. It now removes them by default",
    "Group membership is what grants file-share, application and group-based licence access, so this was the offboard not actually offboarding",
    "Protected and privileged groups are still never stripped — well-known admin groups, anything in a Privileged OU, and each client's own protected list. Each one is reported on the case as a manual removal instead, exactly as before",
    "The default also forces a snapshot of the user's memberships BEFORE anything is removed, so the change can be undone. 16 of those clients were capturing no evidence on offboard, and stripping groups nobody recorded would have been a one-way door",
    "A client that wants different behaviour still gets it: named group rules are respected as before, and setting \"remove all groups\" to false is an explicit opt-out the engine honours",
    "The case says which it was — a configured choice or the engine's default",
    "Runner 1.114.0 needs deploy for the explanatory line; the removal itself works as soon as this ships",
  ],
};
