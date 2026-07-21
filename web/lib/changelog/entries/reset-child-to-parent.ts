import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "reset-child-to-parent",
  date: "2026-07-21",
  time: "16:30",
  title: "Reset a child client back to inheriting from its parent",
  items: [
    "After accidental edits, a child client could be stuck with its own systems/credentials shadowing the parent's, with no way back (FR #0000023)",
    "The parent-inheritance control now has a “↩ reset to parent” action for a child with its own systems: choose “Systems only” (revert systems + rules, keep the child's credential wiring) or “Everything” (also delete the child's own Delinea references so the parent's broker)",
    "The Systems editor gains a per-row “↩ revert to parent” that resets one system to the parent's version",
    "Destructive and confirmed: deleting a child's credential reference loses the wiring, not the vault secret (re-wiring is manual). Audited as client.reset_to_parent with counts only. Web-only, no migration",
  ],
};
