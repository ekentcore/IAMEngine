import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "run-log-fixed-no-longer-buries-a-recurrence",
  date: "2026-07-16",
  time: "10:15",
  title: "Marking a run-log line \"Fixed\" no longer hides the same problem when it happens again",
  items: [
    "\"Fixed\" used to apply to future occurrences too: mark a warning fixed once, and every later identical warning was created already-hidden and left out of the problem count. If it wasn't actually fixed, the step could keep failing forever and the run log would never say so",
    "That's exactly what happened on UM0029796 — the \"MFA methods NOT removed\" and \"license KEPT\" warnings were marked Fixed while the case was being closed. Neither was fixed: the permission is still missing and the seat is still assigned",
    "Now a problem that comes back, comes back visibly. \"Fixed\" dismisses what you've seen; if the same thing happens again, you'll see it again",
    "This adds no noise — a step that's genuinely fixed stops printing the warning, so it can never match the old line. Marking one line Fixed still clears every existing copy of it",
  ],
};
