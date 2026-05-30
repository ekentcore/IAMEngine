## Active Directory (`active-directory`)

`Module: Coretelligent.ActiveDirectory` · `Mode: api (via client-network agent)` · `Build tier: 2` · `Appears in: ~37%` · `Lanes: both`

On-prem AD user lifecycle. Runs on the client-network agent (PowerShell AD module against
the local DC), never centrally. Identity origin for `ad-synced`/`ad-standalone` clients.

### Auth
Secret: `ad-dc` (domain admin / delegated service account). Executed locally by the agent;
no inbound connectivity. `ActiveDirectory` PowerShell module on the DC/management host.

### Onboard lane
`always`. (1) Create user in the client's OU (per-client path) with the username pattern
(respect lowercase). (2) Set attributes: `proxyAddresses` (SMTP:user@domain), telephone,
manager, department, company, display name, office. (3) Map home drive (e.g. H: →
\\fs\Users\<username>). (4) Add security groups, including conditional ones (VPN Users if
VPN, AVD core group if AVD, Perimeter groups, geo Printix groups). (5) Hand off to
`directory-sync`. Post: enabled account in the correct OU with groups + attributes.

### Offboard lane
`always`, `captureEvidence`. (1) Reset password (capture for manager if `reset-and-capture`).
(2) Screenshot all group memberships and attach to the case, then remove all groups (this
cascades to KnowBe4 etc. on sync). (3) Hide from GAL (method varies: "Hide from GAL" flag or
`msDS-cloudExtensionAttribute1 = HideFromGAL`). (4) Remove manager. (5) Disable the account.
(6) Move to the Disabled Users OU — UNLESS the client has the `do-not-move-ou` guardrail
(moving the OU deletes the user in 365). Then `directory-sync`.

### Config keys
`ou`, `groupsOu`, `homeDrive{letter,unc}`, `groups[]`, `conditionalGroups[{when,groups}]`,
`hideFromGal{method,attribute,value}`, `disabledUsersOu`, `guardrails[]`, `attributes`.

### Functions
`Invoke-CtgADOnboarding`, `Invoke-CtgADOffboarding`, `New-CtgADUser`, `Set-CtgADAttributes`,
`Add-CtgADGroups`, `Remove-CtgADGroups` (with evidence), `Disable-CtgADUser`, `Move-CtgADUser`.

### Depends on
`servicenow` (onboard). `directory-sync` runs immediately after on both lanes.

### Variants & gotchas
Per-client OU paths (e.g. `rhcp.local > 1penn plaza > staff`); lowercase usernames;
`proxyAddresses` attribute editor step; hide-GAL method differs by client; the
`do-not-move-ou` trap (Six One) vs move-to-Disabled-Users (Regal/UOVO); group removal
cascades to provisioning-by-group systems.

### Manual fallback
If the agent is offline, the whole module is surfaced as a manual checklist with the
resolved OU/group/attribute values.
