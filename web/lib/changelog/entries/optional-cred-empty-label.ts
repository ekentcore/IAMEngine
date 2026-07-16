import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "optional-cred-empty-label",
  date: "2026-07-15",
  time: "13:15",
  title: "An empty optional credential now reads '(optional)' in grey, on the client and the case",
  items: [
    "When a credential is optional (like ad-dc, or the Spanning portal login) and hasn't been wired, its name now shows a grey '(optional)' next to it - on both the client's credentials panel and a case's credentials - so a blank one reads as 'fine to leave unset', not as a missing credential",
    "On the client this replaces the old always-on 'optional' pill: the hint now appears only when the credential is actually empty. Wire it and the '(optional)' marker goes away",
    "Display only - nothing about how credentials are brokered or tested changed",
  ],
};
