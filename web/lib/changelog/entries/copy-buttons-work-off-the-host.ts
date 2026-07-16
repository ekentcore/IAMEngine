import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "copy-buttons-work-off-the-host",
  date: "2026-07-16",
  time: "14:15",
  title: "Copy buttons now actually copy — and stop claiming they did when they didn't",
  items: [
    "Every copy button in the app did nothing for everyone except whoever runs the app on their own machine. Browsers only expose the clipboard to pages served over HTTPS (or opened as localhost), and the app is served over plain HTTP on the office network — so the copy silently went nowhere and you had to select the text by hand",
    "Worse, almost every button then said \"Copied ✓\" regardless. It couldn't tell it had failed, so it reported success over an empty clipboard",
    "That was dangerous in three places: the one-time password dialogs. The password is shown once and wiped the moment you click \"I saved it\" — so a copy that quietly did nothing, followed by that click, destroyed the only copy of it",
    "Copy now falls back to a method that works without HTTPS, so the buttons work from any machine. If a copy genuinely can't happen, the button says \"copy blocked\" and explains why, instead of pretending",
    "Verified from a real browser on a real office-network URL: the clipboard is confirmed unavailable there, the fallback copies anyway, and pasting afterwards returns the exact text",
    "Twelve copy buttons had been written twelve slightly different ways, each with its own version of this bug. They are now one button",
  ],
};
