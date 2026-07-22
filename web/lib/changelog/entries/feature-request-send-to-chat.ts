import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "feature-request-send-to-chat",
  date: "2026-07-22",
  time: "11:15",
  title: "Feature requests can now be announced to the client chats, with the request and its resolution",
  items: [
    "Every feature request on /feature-requests (admin view) now has a \"Send to chat\" button — on the board and in the Completed table, at any status, so a request can be broadcast once it's Implemented (or any other time you want to share it)",
    "Pick the audience the same way the change-log send does: the All-clients chat, the Restricted chat, or both. It fans out to whatever platforms (Teams / Slack / Zoom / email) are configured for that side in Settings, and reports per-channel delivery inline",
    "The message is composed server-side from the request itself — its number (e.g. #0000024), title, the requested item as it was filed, and the resolution note — plus an optional comment you type on top. The browser never supplies the content, so it can't be tampered with",
    "Like the change-log send, this bypasses the notifications master switch (it's an explicit operator action) but only ever uses your SAVED chat destinations, and it's limited to Global Admin and above",
    "Marked FR #0000024 (Active-directory / directory-sync readiness) as Implemented with its resolution note while wiring this up",
  ],
};
