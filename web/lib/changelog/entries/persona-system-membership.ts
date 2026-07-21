import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "persona-system-membership",
  date: "2026-07-21",
  time: "16:15",
  title: "Roles & rules: pick which personas receive a “by persona” system",
  items: [
    "A system set to the “by persona” lane runs for a hire only when the selected persona lists it — but the Roles & Rules editor gave no way to set that except as a side effect of adding a group/OU/attribute (FR #0000022)",
    "The editor now badges which systems are “by persona” and shows a per-persona “Systems this persona receives” checklist — check a system to include it for that persona, with no group/OU needed",
    "Checking a system you've already configured keeps its groups/OU/attributes; unchecking removes the persona's membership of it",
    "Read-only client view labels membership-only systems (“receives this system”). No change to the planner — it already gates on persona membership; web-only, no migration",
  ],
};
