# AD ↔ Entra consistency check (`ad-consistency-check`)

`Module: Coretelligent.ActiveDirectory` (rides the AD module) · `Mode: api (agent)` ·
`Build tier: 2` · `Appears in: every hybrid (AD + cloud) client` · `Lanes: onboard`

**Detect-only** (Design D, level 2). Verify that the on-prem AD object will LINK to its
Entra object instead of spawning a **duplicate** — the Entra source anchor (`immutableId`)
must equal `base64(objectGUID)` **or** `base64(mS-DS-ConsistencyGuid)`. Flags a mismatch
or a cloud-only object; it never writes (a hard-match auto-write is a later level).

Backbone relevance — hybrid only. Planner-injected (no ClientSystem row) for any onboard
with `active-directory` + a cloud consumer (`m365`/`entra`), running after them.

### Auth
`ad-dc` (the AD module's DC credential). **No cloud credential** — the Entra object's
`{ immutableId, syncEnabled, userId }` is read centrally by the m365 step and injected into
this job's payload as `cloudObject` at dispatch (`runner-service.claim`), mirroring the B1
routing of `ad-email-writeback`.

### Onboard lane
`when: always` (hybrid). Depends on `m365`/`entra` (and `ad-email-writeback`). Steps:
1. Resolve the on-prem user (`SamAccountName` → `UPN` → unique `DisplayName`); read
   `objectGUID` + `mS-DS-ConsistencyGuid` and base64-encode each (the two possible anchors).
2. Compare to the injected Entra `cloudObject`:
   - **no cloud object** (`userId` null) → ok, a fresh sync will create + anchor it.
   - **cloud-only** (`syncEnabled == false`) → **WARN**: a cloud-only object exists; the
     on-prem account won't hard-match it → AAD Connect will create a **duplicate**.
   - **immutableId matches** an anchor → ok, linked.
   - **immutableId doesn't match** → **WARN**: objects may be unlinked (possible duplicate);
     verify the AAD Connect source anchor.

Returns `{ System='ad-consistency-check'; Status='ok'; Sam; Flagged; Actions[] }` — a WARN
action surfaces on the case run report. `Flagged=true` when there's a duplicate risk.

### Config keys
None. (`m365` returns `OnPremImmutableId` + `OnPremSyncEnabled` for the check.)

### Functions
- `Invoke-CtgADConsistencyCheck -User <payload> -Config -AdConnection` (onboard).
- `Get-CtgAdCaseUser` helper (resolve the case's AD user).

### Depends on
`m365`, `entra`, `ad-email-writeback` (filtered to those present). Routed on-prem via
`ALWAYS_ON_PREM_SYSTEMS`; capability maps to `active-directory` (no new cap to advertise).

### Variants & gotchas
- **Source anchor:** AAD Connect's default is `mS-DS-ConsistencyGuid` (older = `objectGUID`).
  We check BOTH so the compare is correct whichever it uses.
- **Ordering:** runs after the AD create + sync + m365, so by then a pre-existing cloud twin
  has either hard-matched (ok) or duplicated (flagged) — this surfaces which.
- **Detect-only:** this step never writes. When it flags an anchor MISMATCH, the case offers a
  **operator-confirmed "Link to existing Entra account"** action → `ad-hard-match` (below).

### Hard-match (`ad-hard-match`) — operator-confirmed link
Not planned; dispatched on demand by the "Link" button after a flag. `Invoke-CtgADHardMatch`
sets `mS-DS-ConsistencyGuid` = the Entra `immutableId` (from the m365 result, injected by
`POST /api/cases/:id/hard-match`) so AAD Connect links the objects on the next sync. Guarded:
refuses anything that isn't a 16-byte base64 GUID; idempotent. Anchor-mismatch case only — a
**cloud-only** object has no `immutableId` to copy (422 → resolve manually / via Graph).

### Manual fallback
For the cloud-only case (or if the operator prefers), resolve the link by hand — set the cloud
`immutableId` via Graph, or soft-match by primary SMTP — before the duplicate propagates.
