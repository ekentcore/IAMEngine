import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "documents-upload-redline-progress",
  date: "2026-07-15",
  time: "17:30",
  title: "Documents: upload your own edits, redline any two versions, and a clearer 'Update with AI'",
  items: [
    "'Update with AI' now shows a progress window while it runs - reading the change log, asking the model (with a live timer), parsing the reply, building the redline - instead of a button that just says 'Generating…'",
    "Fixed the AI dropping large parts of a document: it now has room to reproduce the whole document and is instructed to copy every section through verbatim, and a draft that comes back much shorter than the current version is blocked from publishing until you review the redline and confirm",
    "New 'Upload' button: download a document, edit it in Word or a text editor, and upload it back (.docx or .md). It becomes a draft you review and publish like any other - and old versions are always kept",
    "Redline any two versions from the version history against each other, not just a pending draft - handy for seeing exactly what changed between v1.2 and v1.5",
  ],
};
