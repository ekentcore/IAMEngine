import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-case-requested-delegate",
  date: "2026-07-16",
  time: "22:15",
  title: "Offboarding grants the delegate the ticket actually asked for",
  items: [
    'The offboard form captures "provide mailbox access to <person>" — and nothing ever read it. Only the profile-static "grant the MANAGER access" rule ran, so the requested delegate (UM0029777: Peter Hegland) silently got nothing. (FR #0000007)',
    "The named delegate now flows onto the exchange step: the display name is resolved to a mailbox at run time and granted Full Access with AutoMapping, idempotently. An unresolvable or ambiguous name is a loud warning telling you to grant it by hand, never a silent skip.",
    "The plan preview shows both delegate grants (manager rule and case-requested) before anything runs. Runner 1.69.0.",
  ],
};
