import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-recovery-cert",
  date: "2026-07-20",
  time: "17:00",
  title: "M365 setup: recovery now rotates the certificate too, and optional-permission failures are surfaced",
  items: [
    "When re-running setup to recover a client whose credential was never really vaulted (the stranded/placeholder case), provisioning forced a fresh client secret but KEPT the existing certificate — whose PFX + password are unrecoverable. So the vault got a secret with no cert material: the certificate was never (re)created/uploaded and certificatebase64/certificatepassword never reached the Delinea credential.",
    "forceReissue now rotates the CERTIFICATE as well as the secret, so a recovery run mints + uploads a fresh cert and vaults its base64 + password — a complete, usable credential (the runner needs the cert for Exchange app-only auth).",
    "The result modal now surfaces optional Graph permissions that didn't get granted (e.g. MailboxSettings.Read) with the reason from the run log, and a 'Set up again to retry' hint — so 'that permission isn't set' always has an answer instead of being buried. (Every optional permission, MailboxSettings.Read included, is already offered in the setup form's checklist.)",
  ],
};
