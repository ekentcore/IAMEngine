import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-setup-placeholder-secret-id",
  date: "2026-07-20",
  time: "16:45",
  title: "M365 setup: fix the vault write treating a 'REPLACE_ME' placeholder as a real credential",
  items: [
    "Most clients (≈106/137) carry an m365-admin Secret row whose externalId is the 'REPLACE_ME' seed placeholder (or blank) — an un-wired reference, not a real Delinea id. The auto-setup write trusted it as a live secret, which broke two ways.",
    "Issued path: it PUT the credential fields to Delinea secret id 'REPLACE_ME', which 400s — the '400, couldn't write it' failure. Now a placeholder falls through to CREATE, minting a real secret and wiring its real id over the placeholder.",
    "Kept-valid path: it returned ok:true and surfaced 'REPLACE_ME' as the vaulted id — a run that 'appeared to work' but named a credential that doesn't exist. Now a placeholder is treated as stranded, so the recovery path re-issues and vaults a REAL secret.",
    "Both sites now gate on secretIsSet() (the same real-id check the rest of the app uses; the runner's Get-CtgSecret also throws on 'REPLACE_ME'). The result modal also refuses to show a placeholder as the credential id.",
    "Recovery affordance: a COMPLETED setup now has a 'Set up again' button (previously only a failed run could be re-run), and a done run with no real credential says so plainly ('No Delinea credential is wired … Click Set up again') instead of showing the placeholder — so a client like Stride that recorded 'complete' with nothing vaulted can be re-run to create and vault a real secret.",
    "Also fixed 4 stale write tests whose fake fetcher didn't account for #142's '?autoComment=' query on the field PUT — the full suite is green again.",
  ],
};
