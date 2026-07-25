import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "locations-active-filter-fixed",
  date: "2026-07-25",
  time: "18:15",
  title: "Locations: refresh pulls only the client's active sites again",
  items: [
    "The active-only filter added for FR#28 used parentheses in the ServiceNow query, which sysparm_query doesn't support — ServiceNow treated the query as invalid and matched every location, so a refresh could pull sites belonging to other clients",
    "The filter also targeted a field that doesn't exist on cmn_location (active); the instance's real flag is the custom u_active field, so even a well-formed query would have filtered nothing",
    "The query is now company=<client>^ORaccount=<client>^u_active=true (verified against the live instance): only the client's own locations, inactive sites excluded",
  ],
};
