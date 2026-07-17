import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "feature-requests-menu-badge-live-counts",
  date: "2026-07-17",
  time: "16:30",
  title: "Feature requests: open-count badge on the menu link, and total/open/implemented counts that update without a refresh",
  items: [
    "The 'Feature requests' item in the nav menu (and the mobile drawer) now shows a small count pill with the number of open requests. When nothing is open, no pill shows",
    "The 'N total · N open · N implemented' line on the board now updates the instant you change a request's status - no page refresh. Mark one Implemented and 'open' drops and 'implemented' rises immediately",
    "The menu badge stays in sync live too: it moves the moment an admin re-triages a request on the board, and bumps by one when anyone files a new request from the 💡 button. It reconciles to the real server count on the next navigation",
  ],
};
