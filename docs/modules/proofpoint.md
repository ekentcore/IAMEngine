## Proofpoint (`proofpoint`)

`Module: Coretelligent.Proofpoint` · `Mode: api` · `Build tier: 3` · `Appears in: ~2%` · `Lanes: both`

Email-security alternative to Mimecast (minority of clients). Same slot in the orchestrator.

### Auth
Secret: `proofpoint-admin` (Proofpoint API).

### Onboard lane
`always` (for Proofpoint clients). Sync/provision the user; verify presence.

### Offboard lane
`always` (light). User removal follows directory removal.

### Config keys
`syncMode`, `verifyDomain`.

### Functions
`Invoke-CtgProofpointSync`, `Confirm-CtgProofpointUser`.

### Depends on
`m365` / source identity.

### Variants & gotchas
Build only after Mimecast (far more common); keep the interface parallel to Mimecast so the
orchestrator's email-security slot is vendor-agnostic.

### Manual fallback
Console sync + verify.
