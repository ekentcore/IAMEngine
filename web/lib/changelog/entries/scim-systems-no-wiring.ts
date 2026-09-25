import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "scim-systems-no-wiring",
  date: "2026-09-22",
  time: "17:30",
  title: "SCIM systems no longer ask for credentials",
  items: [
    "A system set to SCIM is provisioned by the identity provider and never runs a job, so its secrets no longer appear in Secret wiring or the setup wizard as something to wire",
    "The systems editor and the client's systems table show \"not needed (SCIM)\" instead of a Secrets field; any names already saved are kept, so switching the system back to api restores them",
    "A secret a SCIM system shares with another system still shows, listed under the other system only",
  ],
};
