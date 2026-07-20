import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "delinea-secretserver-cloud-create-fix",
  date: "2026-07-20",
  time: "14:00",
  title: "Fix Delinea secret creation against Secret Server Cloud (M365 auto-setup could never vault a credential)",
  items: [
    "Creating a secret in Delinea failed on Secret Server Cloud for three reasons, so the M365 auto-setup would provision an app registration but never store the credential - stranding a one-time secret every run",
    "The template stub was fetched with 'filterSecretTemplateId' and no folder; Secret Server Cloud needs 'secretTemplateId' plus the target 'folderId' (it 400s with 'Folder is required' otherwise)",
    "The create POST sent a hand-built body; Secret Server requires the full stub model handed back (siteId, active, policy flags), so the minimal body was rejected as 'The request is invalid.'",
    "Updating a field 400'd with 'requires a comment when viewed' under a require-comment policy - the field PUT now sends an autoComment, the same way the read path already does",
    "Verified end-to-end against the live vault (create + field update + read-back, then cleanup); the field mapping matches the 'Entra Azure AD Account' template exactly, so only DELINEA_TEMPLATE_M365_ADMIN needs setting",
  ],
};
