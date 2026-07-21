import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-console-signin-secret-ref",
  date: "2026-07-21",
  time: "14:15",
  title: "Mimecast browser setup: test sign-in with a Delinea secret id, no wiring needed",
  items: [
    "The Setup Mimecast API dialog's Automatic (browser) tab now has an optional Delinea secret id field. Enter the id of a mimecast-console login and Test sign-in uses it for that one run - nothing is stored on the client and no persistent secret has to be wired first",
    "Leave the field blank and it behaves as before: the test uses the mimecast-console secret already wired on the client, and refuses with guidance if none is wired",
    "The typed id is passed transiently as a case-level secret override (the same mechanism the M365 device-code and Google Workspace setups already use), so the runner brokers a short-lived credential and the id is never saved",
  ],
};
