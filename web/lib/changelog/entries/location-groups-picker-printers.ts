import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "location-groups-picker-printers",
  date: "2026-07-17",
  time: "17:45",
  title: "Location targets: pick AD/365 groups from a list, plus a separate printers box",
  items: [
    "Each client location now has a proper groups picker instead of one free-text box: a searchable multi-select of the client's already-discovered directory groups, grouped by type - 365 Distribution, 365 Security, 365 Groups, and AD. Pick as many as you like; each shows as a removable chip",
    "Printers get their own box next to it - type a printer name and it's captured separately from groups (no more guessing whether an entry was a group or a printer)",
    "Existing entries auto-classify on first view: names that match a discovered group stay under Groups, the rest move to Printers (and it only guesses when the client actually has discovered groups). Nothing is changed until you save, so you can correct either box first",
    "At plan time, groups still union into the AD/Entra add exactly as before, but printers now become a single 'Map printers at <location>' manual checklist step on the onboarding case - with a 'mark complete' button - instead of being force-added as if they were groups",
    "The locations table is now double-line: address details on top, the groups picker + printers box as a tidy sub-panel beneath each location",
  ],
};
