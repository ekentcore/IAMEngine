import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-cert-unit",
  date: "2026-07-20",
  time: "17:15",
  title: "M365 setup: issue the client secret and certificate as one unit so the cert always gets vaulted",
  items: [
    "Symptom (core1787 / secret 56977): the vaulted credential had the client secret but no certificatebase64 / certificatepassword, and the connection test reported the certificate AND Exchange.ManageAsApp missing.",
    "Cause: provisioning issued the secret and the cert INDEPENDENTLY — a run that needed a fresh secret but had a still-valid cert re-issued only the secret and kept the cert. A kept cert's PFX + password are unrecoverable, so they never reached Delinea; the fresh secret entry got a secret with no cert material.",
    "Fix: secret + cert are now issued as a UNIT — whenever either is missing/expired (or a stranded recovery forces it), BOTH are rotated, so a 'issued' credential always carries a complete, vaultable secret+cert set.",
    "This also clears the 'Exchange.ManageAsApp missing' test result: Connect-CtgExchange is app-only CERTIFICATE auth, so with no cert on the secret the runner can't connect to Exchange at all and can't verify the role. With the cert vaulted, Exchange connects and verifies. (MailboxSettings.Read is a separate Graph grant — it's in the setup checklist; if it still reads missing after a re-run, the result modal now shows the grant reason.)",
  ],
};
