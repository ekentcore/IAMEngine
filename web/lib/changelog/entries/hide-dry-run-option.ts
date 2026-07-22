import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "hide-dry-run-option",
  date: "2026-07-22",
  time: "10:15",
  title: "Retire the dry-run option on cases",
  items: [
    "Removed the dry-run controls from cases: the case-page toggle, the ServiceNow import checkbox, and the New case form checkbox — new cases always run live",
    "Dry run ran executors under PowerShell -WhatIf, which suppresses cmdlet output (e.g. New-MgUser returns nothing) and produced misleading failures like an unset $userId rather than a true read-only preview",
    "A case already in dry-run still shows its state and a “Turn off dry run & run for real” button so it isn't stranded",
  ],
};
