## Mimecast (`mimecast`)

`Module: Coretelligent.Mimecast` · `Mode: api` · `Build tier: 2` · `Appears in: ~88%` · `Lanes: both`

Email-security gateway. Near-core. The email-security slot is a vendor variant: a client
has Mimecast OR Proofpoint — the orchestrator treats them as the same capability.

### Auth
Secret: `mimecast-admin` (Mimecast API 2.0 application keys).

### Onboard lane
`always`. Trigger directory sync (Sync All / Sync Directory), then verify the user appears
in the internal directory for `@domain`. Membership in TTP / Large File / Secure Send groups
is often driven from M365 groups (verify).

### Offboard lane
`always` (light). User removal flows from the directory sync once the source account is
disabled/removed; optionally apply a hold.

### Config keys
`syncMode` (sync-all/sync-directory), `verifyInternalDirectory` (domain), `syncTimeoutSeconds`,
`pocApprovalGroups[]`.

### Functions
`Invoke-CtgMimecastSync`, `Confirm-CtgMimecastUser`.

### Depends on
`m365` / `active-directory`+`directory-sync` (the source identity must exist first).

### Variants & gotchas
On-demand directory-sync trigger via API is the open question — may need to poll the
scheduled sync and verify rather than force; some groups require licensing (POC approval).

### Manual fallback
Trigger sync + verify in the Mimecast Admin Console.
