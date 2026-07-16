import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "changelog-page",
  date: "2026-07-12",
  time: "23:30",
  title: "Change log page + send to chat",
  items: [
    "New /changelog page (global admins and above): every shipped feature, newest first",
    "Send any entry to the configured chat channels (Teams, Slack, Zoom, Email) with an optional comment",
    "Audience choice per send: All clients chat, Restricted chat, or both",
  ],
};
