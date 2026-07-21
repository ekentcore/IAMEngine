import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "google-setup-reopen-form-after-failure",
  date: "2026-07-21",
  time: "16:15",
  title: "Google auto-setup modal reopens on the form after a failed run - so you can enter a new secret id",
  items: [
    "Reopening 'Set up Google Workspace automatically' always jumped to the last run's screen, because the modal shows whatever the latest run was - and a run that failed hours ago still counts",
    "That left you staring at the old failure with no visible place to type the super-admin Delinea secret id, which looked like the modal was stuck on a cached run (it wasn't - the secret id is never stored; the input was just hidden behind the failed-run screen)",
    "Now a stale failed/cancelled/skipped run reopens on the FORM, with the input ready and the prior error shown as a note above it; a live run (running/pending) or one that vaulted a credential (done/needs_action) still reopens on its progress screen so you can watch it or copy the wired id",
    "The old path still works too - the failed screen's 'Re-run setup' button returns to the same form",
  ],
};
