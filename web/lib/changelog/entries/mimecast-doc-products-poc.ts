import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mimecast-doc-products-poc",
  date: "2026-07-16",
  time: "17:45",
  title:
    "Mimecast setup guide: the product list matches what the console actually offers, and the point of contact is spelled out",
  items: [
    'The guide told you to enable a "Directory (Sync) Management" product that does not exist in the Mimecast console. Directory sync and group membership are covered by User & Group Management, so the list is now three products and says which one does what. (FR #0000010)',
    "Step 1 now says exactly what to put in the application's contact details: point of contact Coretelligent, email <coreid>@help.support.tech — instead of just \"fill the contact details\". (FR #0000011)",
  ],
};
