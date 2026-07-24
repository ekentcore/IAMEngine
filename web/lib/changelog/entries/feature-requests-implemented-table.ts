import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "feature-requests-implemented-table",
  date: "2026-07-24",
  time: "15:45",
  title: "Feature requests: implemented ones move straight into a table below, so the board is only what is left",
  items: [
    "Marking a request Implemented (or Rejected) now moves it off the board immediately, into an 'Implemented and closed' table underneath. It used to sit on the board for another seven days first, which meant the list you scrolled through was a mix of work still to do and work already finished. The board is now the queue: its length is how much is actually left",
    "The table below shows the number, the request, its status, and who filed it - so 'what shipped recently?' is one glance rather than a scroll through the board",
    "Anything resolved more than seven days ago folds one step further, into a collapsed 'Archived' section beneath the table. Nothing is ever deleted - every request is still there under its number, and expanding the section shows it",
    "Rejected requests now archive on that same seven-day timer. Before, only Implemented ones did, so a rejected request stayed in view until an admin cleared it by hand",
    "Admins get the same controls, just moved to where the request now lives: the status select (setting one back to Planned or Being scripted returns it to the board), 'Archive now' to fold a recent one away early, and 'Restore for 7 days' to lift an archived one back into view - clickable again each time that week runs out",
    "The 'Open' count in the menu badge and the summary line already worked this way - not-yet-resolved, regardless of any timer - so the board now agrees with the number that was being reported all along",
  ],
};
