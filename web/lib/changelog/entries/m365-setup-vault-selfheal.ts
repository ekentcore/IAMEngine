import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-vault-selfheal",
  date: "2026-07-20",
  time: "17:30",
  title: "M365 setup: a half-vaulted credential now self-heals, grant outcomes reach the run log, and a Rotate-credentials option",
  items: [
    "Why re-runs kept 'doing nothing' (core1787): once the app's secret + cert were both valid ON THE APP, every re-run read kept-valid and no-op'd — even though the VAULT was missing the certificate fields from an earlier secret-only rotation. The kept-valid path now reads the vault row's cert slug: template-supported but EMPTY means half-vaulted → stranded → the recovery path rotates secret + certificate together and re-vaults the complete credential. A password-only template (no cert slug) is still fine, and an unreadable vault fails safe (no churn).",
    "Why you couldn't see the permission grants: provisioning's own step log (granted (admin-consented) X, WARN could not grant MailboxSettings.Read: …, the Exchange.ManageAsApp / Exchange Administrator lines, cert issuance) was never appended to the run log — the log only ever said 'provisioned'. It's now carried verbatim, so the modal's ✓ Exchange line and ⚠ optional-permission warnings finally have real data on live runs.",
    "New 'Rotate credentials' checkbox on the setup form: force a fresh secret + certificate and re-vault them even when the app's current ones are valid — the manual repair for an incomplete vault entry (old secret/cert stop working).",
  ],
};
