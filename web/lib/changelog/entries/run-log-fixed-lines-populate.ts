import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "run-log-fixed-lines-populate",
  date: "2026-07-15",
  time: "10:15",
  title: "Marking a run-log error 'Fixed' now moves it into the Fixed lines table (v2 run log)",
  items: [
    "On the v2 run log, clicking '✓ Fixed' set the line as resolved but the line then disappeared instead of moving to the 'Fixed lines' section below. The Fixed section only ever filled in if you also ticked the 'fixed' filter - so in normal use a fixed error just vanished",
    "The Fixed lines section now loads the resolved lines on its own, every time, independent of the filter. Mark an error Fixed and it drops off the working list and shows up under Fixed lines right away",
  ],
};
