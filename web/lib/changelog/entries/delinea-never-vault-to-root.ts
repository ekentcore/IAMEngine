import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "delinea-never-vault-to-root",
  date: "2026-07-23",
  time: "15:15",
  title: "Credentials are never written to a client's Delinea root folder — always a subfolder, or a clear refusal",
  items: [
    "A credential authored with 'Create in Delinea' for a secret with no vendor-setup module (m365-admin, ad-dc, and other identity/ad-hoc creds) could be written to the client's Delinea ROOT folder instead of a subfolder. The root's permissions are narrower than the subfolders', so the secret 'reads as not viewable' to the team — it looked created but couldn't be accessed",
    "Root cause: a missing setup-catalog module produced an empty subfolder name, and the folder resolver reads a leading empty name as 'write to the parent (root)' — silently defeating the subfolder guard. The create route now filters empty names out (matching the vendor-setup path), so identity/ad-hoc creds resolve to 'Identity Services' and can never fall through to the root",
    "The M365 and Google auto-setup writers previously fell back to the client root when no 'Identity Services' subfolder existed. They now REFUSE with a clear message ('create that subfolder in Delinea, then retry') rather than silently vaulting an unviewable credential",
    "Defence-in-depth: all create paths now hard-refuse if the resolved folder is missing OR is the client root itself, so a future regression can't reintroduce a root write",
  ],
};
