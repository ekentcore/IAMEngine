import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-autorecover-runlog",
  date: "2026-07-20",
  time: "11:15",
  title: "M365 auto-setup: auto-recovers a stranded credential + a live run log",
  items: [
    "A client whose iam-engine app registration was created on a prior write-failed attempt used to error 'reports a valid credential but none is vaulted ... rotate manually' - setup now auto-recovers instead: it re-provisions the app with a freshly rotated client secret and re-writes it to Delinea, bounded to one recovery attempt",
    "Each per-client setup run now keeps a full step/error run log (the same trail already used to explain failures), persisted per client and shown live under the button as an expandable 'details' toggle - open by default on a terminal failure, updating as the poller refreshes",
    "The outcome of every client's setup run (status, stage, appId, warnings) is now also written to the audit trail",
  ],
};
