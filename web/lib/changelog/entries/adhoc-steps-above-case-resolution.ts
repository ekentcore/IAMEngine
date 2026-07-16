import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "adhoc-steps-above-case-resolution",
  date: "2026-07-15",
  time: "22:15",
  title: "On-demand steps (force Spanning sync, password reset, hard match) now insert above Case resolution, which stays the last step",
  items: [
    "Triggering a force Spanning sync, an ad-hoc password reset, or a hard match used to append the new step at the very end — after Case resolution — so the case looked like it finished on a browser sync instead of on its resolution step",
    "The new step now inserts just ABOVE Case resolution, and Case resolution moves down one number so it's always the last step, matching how a freshly planned case reads",
    "This only affects where a newly added on-demand step lands; existing cases already numbered are unchanged",
  ],
};
