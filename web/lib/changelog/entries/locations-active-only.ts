import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "locations-active-only",
  date: "2026-07-24",
  time: "11:45",
  title: "Locations: inactive ServiceNow locations are no longer pulled for clients",
  items: [
    "The ServiceNow location sync (cmn_location) now filters on active=true, grouped so it applies to both the company= and account= branches of the lookup; refreshing a client's locations no longer imports sites ServiceNow has marked inactive, and re-running the refresh drops any already-stored inactive locations from the picker",
  ],
};
