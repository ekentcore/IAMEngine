import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "documents-versioned-in-app",
  date: "2026-07-15",
  time: "16:00",
  title: "Documents: the IAM Engine reference docs now live in the app - versioned, downloadable, and updatable with AI",
  items: [
    "The four reference documents (client overview, setup and configuration guide, security design, and the internal reference) are now a Documents page in the app, instead of Word files passed around by hand",
    "Each document is versioned in-app. The current version renders in the browser, with a version-history table on the document showing every version, its date, who published it, and what changed",
    "Download any document as Word (.docx), a self-contained web page (.html, which prints cleanly to PDF), or Markdown - always regenerated from the current version, so a download is never stale",
    "'Update with AI' reads the change-log entries logged since the document was last revised, proposes a revised draft, and shows you a diff plus a change summary. You review and Publish (a minor or major version bump) or Discard - nothing publishes without a human",
    "Access follows role: any engineer and up can read and download the client-facing docs; the internal reference is visible to global admins and up only; running an AI update and publishing are global-admins-and-up",
    "Seeded at v1.0 from the existing documents. The AI update uses the LLM provider configured in Settings",
  ],
};
