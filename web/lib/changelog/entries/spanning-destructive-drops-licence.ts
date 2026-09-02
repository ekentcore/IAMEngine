import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-destructive-drops-licence",
  date: "2026-09-02",
  time: "10:00",
  title: "A destructive Spanning offboard frees the seat instead of failing to archive it",
  items: [
    "Where a client's Spanning offboard is classified Destructive, the licence is now unassigned and the seat freed, rather than attempting an Archive conversion most clients have no licensing for. (FR #0000095)",
    "That conversion was failing far more often than it worked: of the 60 most recent Spanning offboards, 37 left a billable seat behind and only 17 archived successfully. Kaseya's API cannot convert a Standard licence into an Archive one, so the step warned and handed the seat to a human every time",
    "Four clients are affected — the only ones with Spanning classified Destructive — and three of them are in that failure list",
    "Everyone else is unchanged. For them the Archive conversion IS the intent, and quietly dropping their licences could delete backups nobody agreed to lose",
    "Freeing a Spanning seat can remove backup data, so this stays behind the approval gate a Destructive step already carries: the step will not run until an operator approves it on the case, and it snapshots state first",
    "A client that has deliberately configured a licence swap or removal keeps exactly what it configured",
    "Web-only — no runner change; the runner has always been able to do this, nothing ever asked it to",
  ],
};
