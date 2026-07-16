import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "build-from-systems-preview",
  date: "2026-07-15",
  time: "09:30",
  title: "Build from systems now shows a preview you can edit before it saves, instead of overwriting the runbook the moment you click",
  items: [
    "On a client page, the 'Build from systems' button used to replace the onboard AND offboard runbook the instant you confirmed a browser popup - no chance to see what it generated first",
    "It now opens a preview dialog with an Onboard and an Offboard tab, one section per participating system. You can reorder, rename, relink to a different system, and add or remove steps - the same editing you already had on the paste-a-runbook flow, now reused here",
    "Nothing is written until you press Save; Cancel discards the whole thing and leaves the stored runbook untouched. Save replaces both actions' runbooks with what you see",
    "If a tab has no participating systems it says so and is skipped on save; if you delete every section in a tab, that action is left unchanged rather than wiped",
  ],
};
