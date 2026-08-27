import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "child-replan-parent-fallback",
  date: "2026-08-27",
  time: "10:00",
  title: "Re-planning a child company's case no longer plans nothing",
  items: [
    "A child company with no systems of its own borrows its parent's runbook. That worked when a case was first planned and not when it was re-planned — a re-plan produced ZERO steps, 77% of the time for these clients against 2% everywhere else. (FR #0000042)",
    "The visible symptom was the reported one: groups the ticket asked for were pulled onto the case and then added to nobody. There were no steps to add them to. The re-plan kept the steps from the original plan, so the case still looked healthy",
    "A re-plan was also dropping the parent's roles, personas, every-user rules, locations and username patterns for those clients — the same missing fallback, wider than groups",
    "The inheritance rule now lives in one place used by both paths, because they had already drifted apart once",
    "Unchanged: a child with its OWN systems still does not inherit, and a child with inheritance switched off still does not",
    "Worth watching on the first few: a re-plan on one of these clients will now add the steps it should have had all along, where it used to be a no-op. Finished and in-flight steps are untouched",
    "Web-only — no runner change",
  ],
};
