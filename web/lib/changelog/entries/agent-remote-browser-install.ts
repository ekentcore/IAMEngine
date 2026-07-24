import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "agent-remote-browser-install",
  date: "2026-07-24",
  time: "19:00",
  title: "Install browser automation on any runner remotely - no shell on the host",
  items: [
    "New Install browser action on the Agents page (shown for runners not yet advertising the browser capability): the runner installs everything browser jobs need on its next heartbeat.",
    "Works even when the host has no Node.js - the runner downloads a pinned portable Node into its own folder, then installs Playwright and Chromium in the background while it keeps working.",
    "The row shows queued > installing > done; the runner starts advertising 'browser' and taking browser jobs (Spanning force-sync, vendor console setups) once the install finishes.",
    "Nothing is installed system-wide and the runner's build hash is unaffected, so the agent never reads as permanently out of date. Needs runner 1.105.0.",
  ],
};
