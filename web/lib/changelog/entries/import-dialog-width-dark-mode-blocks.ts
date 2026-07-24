import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "import-dialog-width-dark-mode-blocks",
  date: "2026-07-24",
  time: "14:00",
  title: "Cases v3 import dialog no longer stretches full-width; dark mode fixes on the client page (FR #0000039, #0000040)",
  items: [
    "FR #0000039 — on /cases/v3 the “Import from ServiceNow” dialog (and the New case / Check ServiceNow dialogs) opened stretched to nearly the full screen: the Actions ▾ menu's full-width rule for its trigger buttons was also hitting each action's dialog. Dialogs now keep their normal 440px width.",
    "FR #0000040 — dark mode: the runbook's highlight blocks (Intended automation PowerShell, ✉ Email template, 📎 Attachment) had light text on a hardcoded light-grey background. They now follow the theme.",
    "FR #0000040 — dark mode: in Roles & Rules, the group-name dropdown, the OU folder browser, the persona header, and the “systems this persona receives” box were also light-on-light; all now use theme colors (the Edit-systems OU shadow warning uses the standard warning colors).",
  ],
};
