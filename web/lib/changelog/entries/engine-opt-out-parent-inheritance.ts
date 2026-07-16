import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "engine-opt-out-parent-inheritance",
  date: "2026-07-13",
  time: "16:00",
  title: "Per-client 'do not use engine' + breakable parent inheritance",
  items: [
    "New 'do not use engine' toggle on a client: the intake sweep and manual import skip its ServiceNow cases (reported as skipped, not failed) - cases already imported are kept",
    "Child clients can break the modeled-by-parent link when they don't match the parent, choosing to keep an editable copy of the parent's systems or start empty",
    "A broken link is honored everywhere inheritance was: case planning, the clients list coverage, the secrets panel, and config review",
  ],
};
