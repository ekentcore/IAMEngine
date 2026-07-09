## Active Directory (`active-directory`)

`Module: Coretelligent.ActiveDirectory` · `Mode: api (via client-network agent)` · `Build tier: 2` · `Appears in: ~37%` · `Lanes: both`

On-prem AD user lifecycle. Runs on the client-network agent (PowerShell AD module against
the local DC), never centrally. Identity origin for `ad-synced`/`ad-standalone` clients.

### Auth
Secret: `ad-dc` (domain admin / delegated service account). Executed locally by the agent;
no inbound connectivity. `ActiveDirectory` PowerShell module on the DC/management host.

**Required Delinea fields:** `Username` + `Password`. The target **DC/server is optional.** The
agent normally runs ON the domain controller, so it authenticates in its ambient/local domain
context — `New-CtgAdConnection` (in `Start-IamRunner.ps1`) omits `-Server` and the AD cmdlets bind
to the local DC. Only when the agent runs on a *different* in-network box do you need to name a DC;
the "Active Directory Account" Delinea template has no Server field, so put the DC name in its
**Documentation Link** field (the runner reads `Server`/`DomainController`, then falls back to a
non-URL Documentation Link). Because the field is optional, the Credentials "Test" treats a secret
with just `Username` + `Password` as fully valid (no "missing: domain controller" warning) — which
matches what the runner actually needs on the DC.

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

### Installing the on-prem agent
This system only runs on a client-network agent (DC / management host). Full setup:
see [docs/runner-dc-setup.md](../runner-dc-setup.md).
