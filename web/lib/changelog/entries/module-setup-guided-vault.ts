import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "module-setup-guided-vault",
  date: "2026-07-21",
  time: "22:15",
  title: "Guided credential setup for more vendors, with a Vendor folder + setup provenance",
  items: [
    "Adobe, Zoom, Egnyte, KnowBe4, and Slack now have a guided \"Set up API\" flow (shown only when the client lists that system) — the same paste/verify/vault path M365 and Mimecast use; added the missing Zoom/Egnyte/KnowBe4 field definitions",
    "Vendor API credentials now vault into the client's \"Vendor\" Delinea subfolder (configurable per module); the credential still never lands in the client root — it falls back to \"Identity Services\" and otherwise refuses",
    "New setup-provenance record: for each client+module we store which Delinea secret (and folder) was used to set it up, so when a vendor's permissions need changing you know exactly which credential to edit — read via GET /api/clients/<slug>/setup-credentials",
    "Groundwork for per-vendor browser auto-provisioning: a generalized ModuleSetupRun/ModuleSetupRunClient (keyed by module) so each vendor's browser flow reuses one run/track instead of a new table pair. Additive migration, no runner change",
  ],
};
