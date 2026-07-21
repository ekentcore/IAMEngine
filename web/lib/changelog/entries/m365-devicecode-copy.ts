import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-devicecode-copy",
  date: "2026-07-20",
  time: "19:00",
  title: "M365 setup: the device code is now copyable (and copies itself when you open devicelogin)",
  items: [
    "The sign-in callout's 'Open devicelogin' link is now 'Copy code & open devicelogin' — it copies the device code to your clipboard as it opens the page, so it's ready to paste.",
    "Added a dedicated 'Copy code' button next to the code for when you just want the code without opening the page (flips to 'Copied ✓').",
    "Both are best-effort about the clipboard: on a plain-http LAN origin (where navigator.clipboard is unavailable) the copy is a no-op but the code stays shown as selectable text.",
  ],
};
