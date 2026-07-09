## Proofpoint (`proofpoint`)

`Module: Coretelligent.Proofpoint` · `Mode: api` · `Build tier: 3` · `Appears in: ~2%` · `Lanes: both` · `dependsOn: m365`

Proofpoint Essentials email security. Users are **provisioned by sync, not by API create**:
Proofpoint imports them from Azure AD / Entra ID (or on-prem AD) on its own schedule. There is **no
documented endpoint** equivalent to the console's "Save & Run Sync Now" / "Sync Active Directory"
button, so this module is **read-only**: it verifies whether the user has synced in and returns a
clear status object. It never PUTs settings and never modifies exemptions.

### Auth
Secret: `proofpoint` (Proofpoint Essentials **admin** account — admin-only API). The runner sends the
admin email + password as `X-User` / `X-Password` headers (never logged). Delinea fields:
- **admin email** — `X-User` / `Username` / `AdminUser` / `Email`
- **admin password** — `X-Password` / `Password` / `AdminPassword`
- **org domain** (for the `/orgs/{domain}` path) — `Domain` (else the client's primary domain)
- **pod** — `Region` (`us1`..`us5`, `eu1`, `au1`) or a full `BaseUrl`

### Onboard lane
`always`. Verify-and-wait (no create):
1. `GET /orgs/{domain}/settings/azure` — is Azure/Entra sync on? frequency? `last_successful_sync`?
2. `GET /orgs/{domain}/settings/azure/exemptions` — is the target user exempt?
3. `GET /orgs/{domain}/users/{email}` — has the user synced in yet?
4. Outcome: **present** → ok. **exempt** → hard fail (it will never import; remove the exemption).
   **sync disabled** → WARN (can't import automatically). **not yet** → ok + **auto-retry** (the app
   re-queues, capped) until the next scheduled sync imports the user — same pattern as Spanning's M365
   discovery.

### Offboard lane
`always`. Removal is also sync-driven (`remove_deleted_users`): once the user is deprovisioned in the
directory, the next Azure sync removes them from Proofpoint. The lane reports whether they're still
present and whether removal-on-sync is enabled — no destructive call. WARN if `remove_deleted_users`
is off (they won't auto-remove).

### Status object (the deliverable)
`Get-CtgProofpointSyncStatus -Email` returns: `proofpoint_user_exists`, `azure_sync_enabled`,
`sync_frequency_hours`, `last_successful_sync`, `user_is_sync_exempt`, `sync_trigger_supported`
(`unsupported` — no on-demand API trigger), `likely_status`, `recommended_action`.

### Connection test
Probe reads `GET /orgs/{domain}/settings/azure` — proves admin auth + the org-path domain, and reports
whether sync is on, its frequency, and the last successful sync.

### Functions
`Connect-CtgProofpoint`, `Invoke-CtgProofpointApi`, `Get-CtgProofpointAzureSync`,
`Get-CtgProofpointExemptions`, `Find-CtgProofpointUser`, `Get-CtgProofpointSyncStatus`,
`Invoke-CtgProofpointOnboarding`, `Invoke-CtgProofpointOffboarding`, `Confirm-CtgProofpoint`.

### Notes & gotchas
- **No on-demand sync trigger.** If a sync is urgent, run **Save & Sync** in the Proofpoint console
  (Import & Sync → AD Sync); the API can only configure the schedule and read status, which we do not
  change automatically.
- Safe by design: GET-only; settings/exemptions are never modified; the admin password is never logged.
- Same orchestrator slot as Mimecast (email security) — a client has one or the other.
