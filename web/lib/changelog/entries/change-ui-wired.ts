import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "change-ui-wired",
  date: "2026-07-18",
  time: "19:00",
  title: "Change/mover: dialog + preview live on the pages",
  items: [
    "New \"Change / move user\" action on each client's page: start a mover (persona/location swap) or an ad-hoc access change (groups, DLs, AD OU move) for an existing user",
    "A mover pauses for a scoped/full/add-only removal review before it plans — the review screen now also shows the OU move when the target persona/location relocates the account",
  ],
};
