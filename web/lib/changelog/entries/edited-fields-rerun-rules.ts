import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "edited-fields-rerun-rules",
  date: "2026-08-24",
  time: "18:00",
  title: "Correcting a field on a case re-runs the rules and roles",
  items: [
    "Correct a field the ticket got wrong — department, job title, location, employment type — and the rules and personas that key on it now re-run, so the groups, licences, attributes and OU follow the corrected value. Before, the new value was saved but every rule kept firing on the ticket's original, and the correction silently did not take. (FR #0000091)",
    "Job configs are decided when the case is PLANNED, not when a step runs, which is why saving the field alone was never enough. The case is re-planned automatically after an edit",
    "Only on a case that has not started yet — a field save must not reshape a run already in flight. Started cases are unchanged and still have the Re-plan button. If the re-plan fails the edit is still saved; it is reported, never rolled back",
    "Found while fixing that, and shipped with it: a re-plan silently reverted a hand-corrected username to the pattern-generated one. The merge that preserves operator edits across a ticket re-pull was being undone one step later by the identity derivation, so any re-plan threw the correction away — an edited username, login name, mail nickname or work email is now kept",
    "Two same-named people are still never cross-assigned: nothing is preserved unless it carries an explicit operator-edited stamp, and the conflict-fallback usernames are always re-derived from the client's patterns",
    "Web-only — no runner change",
  ],
};
