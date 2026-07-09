# Coretelligent.Proofpoint — Proofpoint Essentials API (read-only sync verification).
#
# Proofpoint Essentials provisions users by SYNCING them from Azure AD / Entra ID (or on-prem AD) on
# its OWN schedule — there is NO documented endpoint equivalent to the console's "Save & Run Sync Now"
# / "Sync Active Directory" button. So this module does NOT create users or push settings. It VERIFIES,
# read-only, whether the target user has synced into Proofpoint yet and reports a clear status object
# (sync enabled? frequency? last successful sync? user exempt? user present?) plus the recommended next
# action. Onboarding is therefore a verify-and-wait: if the user hasn't appeared, it auto-retries until
# the next scheduled sync brings them in (same pattern as Spanning's M365 discovery).
#
# Auth: admin email + password sent as X-User / X-Password headers (admin accounts only). The password
# is NEVER logged or echoed in an error. We only ever GET; we never PUT settings or modify exemptions.
#   Base URL : https://{region}.proofpointessentials.com/api/v1   (region: us1..us5, eu1, au1)
#   Azure    : GET /orgs/{domain}/settings/azure                  -> { sync_frequency, sync_active_users,
#                add_users, update_users, remove_deleted_users, last_successful_sync, ... }
#   Exempt   : GET /orgs/{domain}/settings/azure/exemptions       -> exempted users (won't sync)
#   User     : GET /orgs/{domain}/users/{email}                   -> the user (404 = not synced yet)

Set-StrictMode -Version Latest

$script:PpBaseUrl  = $null   # e.g. https://us1.proofpointessentials.com/api/v1
$script:PpUser     = $null   # admin email -> X-User
$script:PpPassword = $null   # admin password -> X-Password (never logged)
$script:PpDomain   = $null   # org domain in the path: /orgs/{domain}/...

$script:PpRegions = @{
    us1 = 'https://us1.proofpointessentials.com'; us2 = 'https://us2.proofpointessentials.com'
    us3 = 'https://us3.proofpointessentials.com'; us4 = 'https://us4.proofpointessentials.com'
    us5 = 'https://us5.proofpointessentials.com'; eu1 = 'https://eu1.proofpointessentials.com'
    au1 = 'https://au1.proofpointessentials.com'
}

# StrictMode-safe property read (works for a PSCustomObject or a hashtable; $null when absent).
function Get-CtgProp {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { if ($Object.ContainsKey($Name)) { return $Object[$Name] } return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgProofpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$User,          # admin email (X-User)
        [Parameter(Mandatory)][string]$Password,      # admin password (X-Password)
        [Parameter(Mandatory)][string]$Domain,        # org domain for the /orgs/{domain} path
        [string]$Region = 'us1',
        [string]$BaseUrl                              # full override (host, or host + /api/v1)
    )
    if ($BaseUrl) {
        $u = $BaseUrl.TrimEnd('/')
        if ($u -notmatch '/api/v\d+$') { $u = "$u/api/v1" }  # accept a bare host
        $script:PpBaseUrl = $u
    }
    else {
        $r = ([string]$Region).ToLower().Trim()
        $hostUrl = if ($script:PpRegions.ContainsKey($r)) { $script:PpRegions[$r] } else { $script:PpRegions['us1'] }
        $script:PpBaseUrl = "$hostUrl/api/v1"
    }
    $script:PpUser     = $User
    $script:PpPassword = $Password
    $script:PpDomain   = $Domain
}

function Invoke-CtgProofpointApi {
    # Single HTTP seam (mocked in tests). GET-only in practice; -AllowFail turns a 404 into $null so a
    # not-yet-synced user / absent settings object reads as "not there" rather than throwing.
    [CmdletBinding()]
    param([string]$Method = 'GET', [Parameter(Mandatory)][string]$Path, $Body, [switch]$AllowFail)
    if (-not $script:PpBaseUrl) { throw "Call Connect-CtgProofpoint first." }
    if (-not $script:PpPassword) { throw "Proofpoint: no admin password set on the secret (X-Password)." }
    $p = @{
        Method      = $Method
        Uri         = "$script:PpBaseUrl$Path"
        Headers     = @{ 'X-User' = $script:PpUser; 'X-Password' = $script:PpPassword; Accept = 'application/json' }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { Invoke-RestMethod @p }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($AllowFail -and $status -eq 404) { return $null }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        # Show method + URL + status only — NEVER the X-User/X-Password headers.
        throw "Proofpoint API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function ConvertTo-CtgPpOrgPath {
    param([string]$Suffix)
    "/orgs/$([uri]::EscapeDataString($script:PpDomain))$Suffix"
}

# GET the org's Azure/Entra sync settings. $null when no settings object (e.g. Azure sync never set up).
function Get-CtgProofpointAzureSync {
    Invoke-CtgProofpointApi -Method GET -Path (ConvertTo-CtgPpOrgPath '/settings/azure') -AllowFail
}

# GET the Azure sync EXEMPTIONS (users that won't sync) as a flat list of lowercased emails. Tolerant of
# either a bare array of strings or objects with an email/user field.
function Get-CtgProofpointExemptions {
    $resp = Invoke-CtgProofpointApi -Method GET -Path (ConvertTo-CtgPpOrgPath '/settings/azure/exemptions') -AllowFail
    $list = Get-CtgProp $resp 'exemptions'; if ($null -eq $list) { $list = Get-CtgProp $resp 'users' }; if ($null -eq $list) { $list = $resp }
    @($list) | ForEach-Object {
        if ($_ -is [string]) { $_ } else { (Get-CtgProp $_ 'email') ?? (Get-CtgProp $_ 'user') ?? (Get-CtgProp $_ 'emailAddress') }
    } | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim().ToLower() }
}

# GET a single Proofpoint user; $null (404) when the user hasn't synced in yet.
function Find-CtgProofpointUser {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Email)
    Invoke-CtgProofpointApi -Method GET -Path (ConvertTo-CtgPpOrgPath "/users/$([uri]::EscapeDataString($Email))") -AllowFail
}

# The deliverable: a clear, read-only status object for one user — exists?, sync enabled/frequency/last,
# exempt?, the likely reason they're not in Proofpoint yet, and the recommended next action. Pure reads.
function Get-CtgProofpointSyncStatus {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Email)
    $needle = $Email.Trim().ToLower()
    $azure = Get-CtgProofpointAzureSync
    $freqRaw = Get-CtgProp $azure 'sync_frequency'
    $syncEnabled = $null -ne $azure -and (([string]$freqRaw) -ne '' -and ([string]$freqRaw) -ne '0')
    $lastSync = Get-CtgProp $azure 'last_successful_sync'
    $exempt = @(Get-CtgProofpointExemptions)
    $isExempt = [bool](@($exempt) -contains $needle)
    $user = Find-CtgProofpointUser -Email $Email
    $exists = $null -ne $user

    $likely = if ($exists) { "User is present in Proofpoint (synced from the directory)." }
    elseif ($isExempt) { "User is EXEMPT from Azure sync — it will never import while the exemption stands." }
    elseif (-not $syncEnabled) { "Azure/Entra sync is not enabled for this org — the user can't import automatically." }
    else { "User has not synced into Proofpoint yet." }

    $action = if ($exists) { "None — backup/protection applies via the directory sync." }
    elseif ($isExempt) { "Remove the Azure sync exemption for $Email in the Proofpoint console, then wait for the next sync." }
    elseif (-not $syncEnabled) { "Enable Azure/Entra sync in the Proofpoint console (Import & Sync), then wait for it to run." }
    else { "Confirm the user is active/licensed in Azure AD. If valid, wait for the next scheduled sync; if it's urgent, run Save & Sync in the Proofpoint console (no API trigger exists)." }

    [pscustomobject]@{
        domain                 = $script:PpDomain
        user                   = $Email
        proofpoint_user_exists = $exists
        azure_sync_enabled     = $syncEnabled
        sync_frequency_hours   = if ($null -ne $freqRaw) { try { [int]$freqRaw } catch { $freqRaw } } else { $null }
        last_successful_sync   = $lastSync
        user_is_sync_exempt    = $isExempt
        # No documented endpoint triggers an on-demand Azure/AD sync (only the console button does), so
        # we report this honestly rather than guessing or poking an undocumented endpoint.
        sync_trigger_supported = 'unsupported'
        likely_status          = $likely
        recommended_action     = $action
    }
}

# Resolve the target user's primary email/UPN from the job payload.
function Get-CtgPpEmail {
    param([pscustomobject]$User)
    $e = (Get-CtgProp $User 'UserPrincipalName') ?? (Get-CtgProp $User 'email') ?? (Get-CtgProp $User 'EmailAddress') ?? (Get-CtgProp $User 'userToOffboard')
    if (-not $e) { throw "Proofpoint: the job has no user email/UPN to look up." }
    [string]$e
}

function Invoke-CtgProofpointOnboarding {
    <#
    .SYNOPSIS
        Verify the new user has synced into Proofpoint (Proofpoint imports from Azure/AD on its own
        schedule — no API sync trigger). Read-only. If present -> ok. If exempt -> hard fail (it will
        never import). If sync is off -> WARN. If just not synced yet -> ok + auto-retry until it appears.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = Get-CtgPpEmail $User
    $st = Get-CtgProofpointSyncStatus -Email $email

    $freqNote = if ($st.azure_sync_enabled) { "every $($st.sync_frequency_hours)h" } else { 'sync NOT enabled' }
    $lastNote = if ($st.last_successful_sync) { "last sync $($st.last_successful_sync)" } else { 'no successful sync recorded' }

    if ($st.proofpoint_user_exists) {
        $actions.Add("Proofpoint: $email is present (synced from the directory; $freqNote, $lastNote)")
        return [pscustomobject]@{ System = 'proofpoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ($st.user_is_sync_exempt) {
        throw "Proofpoint: $email is EXEMPT from Azure sync — it will never import. $($st.recommended_action)"
    }
    if (-not $st.azure_sync_enabled) {
        $actions.Add("WARN Proofpoint Azure/Entra sync is NOT enabled for this org, so $email can't import automatically. $($st.recommended_action)")
        return [pscustomobject]@{ System = 'proofpoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    # Enabled + not exempt + not present yet: Proofpoint imports on its schedule. Auto-retry (the app
    # re-queues this job, capped) until the next sync brings the user in — same as Spanning's discovery.
    $actions.Add("Proofpoint has not imported $email yet (Azure sync on, $freqNote, $lastNote) — Proofpoint syncs on its own schedule (no API trigger), so auto-retrying until the user appears. $($st.recommended_action)")
    return [pscustomobject]@{ System = 'proofpoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray(); RetryAfterMinutes = 60 }
}

function Invoke-CtgProofpointOffboarding {
    <#
    .SYNOPSIS
        On offboard, Proofpoint removal is also sync-driven (remove_deleted_users): when the user is
        deprovisioned in the directory, the next Azure sync removes them from Proofpoint. Read-only:
        report whether they're still present and whether removal-on-sync is enabled. No destructive call.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = Get-CtgPpEmail $User
    $azure = Get-CtgProofpointAzureSync
    $removeOnSync = [bool](Get-CtgProp $azure 'remove_deleted_users')
    $user = Find-CtgProofpointUser -Email $email

    if (-not $user) {
        $actions.Add("Proofpoint: $email is not present (already removed by the directory sync)")
        return [pscustomobject]@{ System = 'proofpoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ($removeOnSync) {
        $actions.Add("Proofpoint still shows $email; 'remove deleted users' is ON, so the next Azure sync removes them once they're deprovisioned in the directory — nothing to do here")
    }
    else {
        $actions.Add("WARN Proofpoint still shows $email and 'remove deleted users' is OFF — they won't auto-remove on sync. Remove them in the Proofpoint console if required by the runbook.")
    }
    return [pscustomobject]@{ System = 'proofpoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgProofpoint {
    # Validation read-back: report the user's presence vs. the expected end state for the action.
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [pscustomobject]$Config, [string]$Action = 'onboard')
    $email = Get-CtgPpEmail $User
    $present = $null -ne (Find-CtgProofpointUser -Email $email)
    $expected = if ($Action -eq 'offboard') { -not $present } else { $present }
    [pscustomobject]@{
        System  = 'proofpoint'
        Email   = $email
        Present = $present
        Ok      = $expected
        Detail  = if ($Action -eq 'offboard') {
            if ($present) { "still present (removal is sync-driven — may clear on the next sync)" } else { "removed" }
        }
        else {
            if ($present) { "present (synced)" } else { "not synced yet (imports on Proofpoint's schedule)" }
        }
    }
}

Export-ModuleMember -Function @(
    'Get-CtgProp', 'Connect-CtgProofpoint', 'Invoke-CtgProofpointApi', 'Get-CtgProofpointAzureSync',
    'Get-CtgProofpointExemptions', 'Find-CtgProofpointUser', 'Get-CtgProofpointSyncStatus',
    'Invoke-CtgProofpointOnboarding', 'Invoke-CtgProofpointOffboarding', 'Confirm-CtgProofpoint'
)
