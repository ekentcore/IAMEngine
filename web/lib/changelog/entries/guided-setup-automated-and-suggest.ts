import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-automated-and-suggest",
  date: "2026-07-22",
  time: "12:45",
  title: "Guided setup page: run each automated setup inline + Suggest-from-Delinea on M365/Google creds",
  items: [
    "The guided credential-setup page now offers an “Automatic setup” affordance at the top of each step: an M365/Exchange step gets “Set up M365 automatically”, a Google Workspace step gets the Google service-account flow, and any vendor with a browser-automation catalog entry (Mimecast, Spanning, Adobe, Zoom, Egnyte, KnowBe4, Slack) gets its “Setup <vendor> API” wizard — all embedded inline via the same modals the client Actions menu drives, so an operator never has to leave the wizard. Each step now reads Automatic · Type it · 🔎 Suggest from Delinea",
    "Every step also gains a “🔎 Suggest from Delinea” panel that ranks existing secrets in the client's own Delinea folders; picking one wires + tests it through the same PUT /secrets + field-shape check the paste-an-id box already uses",
    "The M365 and Google automated-setup dialogs now show the same “🔎 Suggest from Delinea” picker beside their Global-Admin / super-admin login-secret inputs, so the sign-in credential no longer has to be a hand-typed Delinea id (new m365-global-admin alias; google-admin now also matches “super admin”/“admin”)",
    "Web-only — no runner change, no migration",
  ],
};
