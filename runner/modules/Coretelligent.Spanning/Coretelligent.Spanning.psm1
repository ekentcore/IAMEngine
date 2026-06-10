#Requires -Version 7.0

# Coretelligent.Spanning  (Spanning Backup for Microsoft 365 — Kaseya/Spanning)
# Per-user SaaS-backup lifecycle. Onboarding ASSIGNS a Spanning Backup STANDARD license so the new
# user's mailbox/OneDrive/SharePoint is protected; offboarding RETAINS the departed user's backups
# (legal/retention) by swapping them to the ARCHIVE license instead of deleting data.
#
# API (verified live against a real tenant, 2026-06):
#   Base URL  : https://o365-api-{region}.spanningbackup.com/external   (region: US, EU, AP, UK, CA)
#   Auth      : HTTP Basic over HTTPS — username = the CLIENT ID, password = the CLIENT SECRET
#               (both from the API section of the Spanning admin console).
#   Get user  : GET  /users/{email} | list GET /users?size=N -> user objects: { displayName,
#               userPrincipalName, email, assigned:bool, isArchive:bool, isAdmin, isDeleted, msId }
#               (legacy docs call the flags licensed/archived — both shapes are read)
#   Assign    : POST /users/assign   { userPrincipalNames:[..], licenseType:"STANDARD"|"ARCHIVE" } -> { licensed }
#   Unassign  : POST /users/unassign { userPrincipalNames:[..] }                                    -> { licensed }
# (Endpoint existence confirmed by probe: /external/{tenant,users,users/assign,users/unassign} 401
# unauthenticated vs 404 for unknown paths. The PUBLIC docs at api.spanningbackup.com describe a
# LEGACY surface — api-{region}.../api/v1 with domain:access-token Basic auth and an `emails` body —
# which rejected a freshly-issued credential. The Connect/read paths tolerate legacy shapes, but the
# WRITE bodies here are external-API only (userPrincipalNames): if a real legacy tenant ever turns
# up, assign/unassign need a body switch keyed off the base URL — don't claim legacy support.)
# Assign/unassign are bulk + idempotent server-side; assigning an already-licensed user returns 200
# with licensed=false ("already had it"). 404 = the user isn't in the caller's domain yet (Spanning
# discovers M365 users on its own schedule — re-run once they appear).

Set-StrictMode -Version Latest

$script:SpanningRegions = @('us', 'eu', 'ap', 'uk', 'ca')
$script:SpanningApiUrl  = 'https://o365-api-us.spanningbackup.com/external'
$script:SpanningUser    = $null
$script:SpanningToken   = $null
# Some tenants 400 the per-user GET route; remember that per process so lookups skip it (reset on Connect).
$script:SpanningUserRouteBroken = $false

function Get-CtgProp {
    # Read a property whether $Object is a hashtable, a generic IDictionary, or a PSObject.
    # Returns $null when absent (StrictMode-safe access).
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgSpanning {
    [CmdletBinding()]
    param(
        # Basic-auth username: the CLIENT ID from the Spanning console's API section. (Legacy
        # domain:access-token tenants pass the account domain here instead — same slot.)
        [Parameter(Mandatory)][Alias('Domain')][string]$Username,
        # Basic-auth password: the CLIENT SECRET (legacy: the access token).
        [Parameter(Mandatory)][string]$AccessToken,
        [string]$Region = 'us',
        [string]$BaseUrl                               # full override (host, or host + /external | /api/v1)
    )
    if ($BaseUrl) {
        # Accept a bare host or a full base: append /external (the verified prefix) when the operator
        # stored just "https://o365-api-us.spanningbackup.com" in apiURL. An explicit /external or
        # legacy /api/v1 suffix is kept as-is.
        $u = $BaseUrl.TrimEnd('/')
        if ($u -notmatch '/(external|api/v\d+)$') { $u = "$u/external" }
        $script:SpanningApiUrl = $u
    }
    else {
        $r = ([string]$Region).ToLower().Trim()
        if ($script:SpanningRegions -notcontains $r) { $r = 'us' }
        $script:SpanningApiUrl = "https://o365-api-$r.spanningbackup.com/external"
    }
    $script:SpanningUser  = $Username
    $script:SpanningToken = $AccessToken
    $script:SpanningUserRouteBroken = $false  # new connection may be a different tenant/API build
}

function Invoke-CtgSpanningApi {
    # Single HTTP seam (mocked in tests). HTTP Basic: clientId:clientSecret (legacy: domain:token).
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:SpanningToken) { throw "Call Connect-CtgSpanning first." }
    $pair = "$($script:SpanningUser):$($script:SpanningToken)"
    $b64  = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pair))
    $p = @{
        Method      = $Method
        Uri         = "$script:SpanningApiUrl$Path"
        Headers     = @{ Authorization = "Basic $b64"; Accept = 'application/json' }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { Invoke-RestMethod @p }
    catch {
        # Surface WHAT was attempted — method + full URL + HTTP status + response body — but NEVER
        # the credential. A bare "400 Bad Request" with no URL is undebuggable from the run report.
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        throw "Spanning API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function Test-CtgSpanning404 {
    # A 404 from get/assign means the user isn't in the caller's domain (not discovered yet) — a
    # benign "absent", not a failure. Robust to both a real HttpResponseException and a test mock
    # that throws a plain error whose message carries the status.
    param($ErrorRecord)
    try {
        $resp = $ErrorRecord.Exception.Response
        if ($resp) { return ([int]$resp.StatusCode) -eq 404 }
    } catch { }
    return ($ErrorRecord.Exception.Message -match '\b404\b|not found|not exist')
}

function Test-CtgSpanningLicensed {
    # Does this user object carry a backup license? The external API's field is `assigned`
    # (verified live: { assigned, isArchive, isAdmin, isDeleted, msId, ... }); the legacy docs
    # call it `licensed`. Read whichever is present.
    param($User)
    [bool]((Get-CtgProp $User 'assigned') ?? (Get-CtgProp $User 'licensed'))
}

function Test-CtgSpanningArchived {
    # Archive-tier flag: `isArchive` on the external API, `archived` in the legacy docs.
    param($User)
    [bool]((Get-CtgProp $User 'isArchive') ?? (Get-CtgProp $User 'archived'))
}

function Test-CtgSpanningSeatError {
    # Is this vendor error an out-of-seats condition (-> procurement warning) rather than a real
    # failure? Require BOTH a license/seat word AND a shortage word, so transient errors like
    # "rate limit exceeded" are NOT swallowed into a procurement note. Defensive — Spanning is
    # usage-billed, so assigns normally just succeed.
    param([Parameter(Mandatory)][string]$Message)
    ($Message -match 'licen[cs]e|seat') -and ($Message -match 'available|limit|exceed|quota|insufficient|out of')
}

# Convert a nextLink (absolute URL, or a path relative to the host) into a path the seam can take
# (relative to $script:SpanningApiUrl, which already carries /external). Returns $null when the
# link can't be mapped — better to stop paging visibly than to silently re-request page 1.
function ConvertTo-CtgSpanningPath {
    param([string]$Link)
    if (-not $Link) { return $null }
    $basePath = ([uri]$script:SpanningApiUrl).AbsolutePath.TrimEnd('/')
    $pq = if ($Link -match '^https?://') { ([uri]$Link).PathAndQuery } elseif ($Link.StartsWith('/')) { $Link } else { return $null }
    if ($pq.StartsWith($basePath)) { return $pq.Substring($basePath.Length) }
    return $pq  # already relative to the API base (e.g. "/users?page=2")
}

function Find-CtgSpanningUser {
    # GET /users/{email}; 404 -> $null (the user isn't in Spanning's domain yet). Some tenants'
    # external API rejects the per-user route with a 400 — remember that verdict for the process
    # (reset on Connect) so every later lookup skips the guaranteed-failing request and goes
    # straight to paging the user LIST (verified working: GET /users?size=1000).
    param([Parameter(Mandatory)][string]$Email)
    if (-not $script:SpanningUserRouteBroken) {
        try { return Invoke-CtgSpanningApi -Method GET -Path "/users/$([uri]::EscapeDataString($Email))" }
        catch {
            if (Test-CtgSpanning404 $_) { return $null }
            if ($_.Exception.Message -notmatch '\b400\b|bad request') { throw }
            $script:SpanningUserRouteBroken = $true
        }
    }
    $needle = $Email.ToLower()
    $path = '/users?size=1000'
    while ($path) {
        $resp = Invoke-CtgSpanningApi -Method GET -Path $path
        $list = Get-CtgProp $resp 'users'
        if ($null -eq $list) { $list = Get-CtgProp $resp 'items' }
        if ($null -eq $list) { $list = $resp }
        $hit = @($list) | Where-Object {
            -not (Get-CtgProp $_ 'isDeleted') -and (
                ([string](Get-CtgProp $_ 'email')).ToLower() -eq $needle -or
                ([string](Get-CtgProp $_ 'userPrincipalName')).ToLower() -eq $needle
            )
        } | Select-Object -First 1
        if ($hit) { return $hit }
        $path = ConvertTo-CtgSpanningPath ([string](Get-CtgProp $resp 'nextLink'))
    }
    return $null
}

function Set-CtgSpanningLicense {
    # POST /users/assign with a license type. Returns the parsed response ({ licensed }).
    # The external API's body key is userPrincipalNames (verified: sending `emails` returns
    # FST_ERR_VALIDATION "body must have required property 'userPrincipalNames'").
    param([Parameter(Mandatory)][string]$Email, [Parameter(Mandatory)][ValidateSet('STANDARD', 'ARCHIVE')][string]$LicenseType)
    Invoke-CtgSpanningApi -Method POST -Path '/users/assign' -Body @{ userPrincipalNames = @($Email); licenseType = $LicenseType }
}

function Invoke-CtgSpanningOnboarding {
    <#
    .SYNOPSIS
        Enable Spanning backup for the new user by assigning a STANDARD license (consumes a seat).
        Idempotent — skips if already licensed. If Spanning hasn't discovered the M365 user yet, says
        so and exits cleanly (re-run later). On a seat/quota error, warns to open a Procurement Case.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email   = $User.UserPrincipalName

    # Some profiles set syncList:true expecting a manual sync trigger. The Spanning API has no sync
    # endpoint — it discovers M365 users on its own schedule — so acknowledge the setting explicitly
    # rather than ignoring it silently.
    if ((Get-CtgProp $Config 'syncList')) {
        $actions.Add("syncList: Spanning discovers M365 users on its own schedule (the API has no sync trigger) — nothing to do")
    }

    if ((Get-CtgProp $Config 'assignLicense') -eq $false) {
        $actions.Add("assignLicense disabled in config — no license assigned")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    # Spanning discovers M365 users on its own schedule; assign 404s until the user appears. Check
    # first so a not-yet-synced user produces a clear "re-run" note rather than an error.
    $found = Find-CtgSpanningUser -Email $email
    if (-not $found) {
        $actions.Add("Spanning has not discovered $email yet (it syncs M365 users on its own schedule) — auto-retrying every 15 minutes until the user appears, then the license assigns")
        # RetryAfterMinutes: the app re-queues this job automatically (capped) — see sweepAutoRetries.
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray(); RetryAfterMinutes = 15 }
    }
    if (Test-CtgSpanningLicensed $found) {
        $actions.Add("backup already enabled for $email (Standard license already assigned)")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    if ($PSCmdlet.ShouldProcess($email, "assign Spanning Backup Standard license")) {
        try {
            $resp = Set-CtgSpanningLicense -Email $email -LicenseType 'STANDARD'
            # The API reports licensed/assigned=true when a license was actually assigned, false when
            # the user "already had a license". Don't claim success the vendor didn't report — the
            # validation read-back checks the real flag either way.
            if (((Get-CtgProp $resp 'licensed') ?? (Get-CtgProp $resp 'assigned')) -eq $false) {
                $actions.Add("Spanning reported no license change for $email (it considers the user already licensed) — the validation read-back confirms the final state")
            }
            else { $actions.Add("assigned Spanning Backup Standard license — backup enabled for $email") }
        }
        catch {
            if ((Get-CtgProp $Config 'procureIfUnavailable') -and (Test-CtgSpanningSeatError $_.Exception.Message)) {
                $actions.Add("WARN no available Spanning backup seats — backup NOT enabled for $email. Open a Procurement Case to order a Spanning license, then re-run this step.")
            }
            else { throw }
        }
    }

    [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgSpanningOffboarding {
    <#
    .SYNOPSIS
        Retain the departed user's Spanning backups — Spanning data is NEVER deleted on offboard.
        Swap them to the ARCHIVE license (swapLicense.to = "Archive") so the backup is kept as an
        archive; or, if config asks to remove the license entirely, unassign (frees the seat). Runs
        last, after the mailbox is converted to Shared and the M365 license removed (lane dependsOn).
        Idempotent — a no-op if the user isn't in Spanning.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email   = $User.UserPrincipalName

    if ((Get-CtgProp $Config 'afterMailboxConvertAndLicenseRemoval')) {
        $actions.Add("runs after mailbox->Shared + M365 license removal (retention-safe ordering)")
    }

    $found = Find-CtgSpanningUser -Email $email
    if (-not $found) {
        $actions.Add("Spanning user not found: $email — nothing to retain or convert")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $actions.Add("retaining existing backups for $email (Spanning data is NOT deleted on offboard)")

    # Default action: swap to ARCHIVE (keeps the backup as an archive). An explicit unassign/removeLicense
    # flag instead frees the seat entirely.
    if ((Get-CtgProp $Config 'removeLicense') -or (Get-CtgProp $Config 'unassign')) {
        if (-not (Test-CtgSpanningLicensed $found) -and -not (Test-CtgSpanningArchived $found)) {
            $actions.Add("Spanning license already removed for $email — no change")
        }
        elseif ($PSCmdlet.ShouldProcess($email, "unassign Spanning license (free the seat)")) {
            Invoke-CtgSpanningApi -Method POST -Path '/users/unassign' -Body @{ userPrincipalNames = @($email) } | Out-Null
            $actions.Add("unassigned Spanning license for $email (seat freed)")
        }
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    $swap = Get-CtgProp $Config 'swapLicense'
    $to   = if ($swap) { [string](Get-CtgProp $swap 'to') } else { 'Archive' }
    $type = if ($to -match 'archive') { 'ARCHIVE' } elseif ($to -match 'standard') { 'STANDARD' } else { 'ARCHIVE' }

    if ($type -eq 'ARCHIVE' -and (Test-CtgSpanningArchived $found)) {
        $actions.Add("Spanning license already Archive for $email — no swap needed")
    }
    elseif ($type -eq 'STANDARD' -and (Test-CtgSpanningLicensed $found) -and -not (Test-CtgSpanningArchived $found)) {
        $actions.Add("Spanning license already Standard for $email — no swap needed")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "swap Spanning license to $type")) {
        try {
            $resp = Set-CtgSpanningLicense -Email $email -LicenseType $type
            $from = if ($swap) { [string](Get-CtgProp $swap 'from') } else { 'Standard' }
            # The vendor docs leave a tier swap ambiguous: assign returns licensed=false when the user
            # "already had a license", which may mean the tier was NOT converted. Report what the API
            # said; the validation read-back checks the archived flag and will flag a real miss.
            if (((Get-CtgProp $resp 'licensed') ?? (Get-CtgProp $resp 'assigned')) -eq $false) {
                $actions.Add("requested Spanning license swap $from -> $to; Spanning reported licensed=false (user already had a license) — the validation read-back confirms whether the tier actually changed")
            }
            else { $actions.Add("swapped Spanning license: $from -> $to (kept an archive seat for retention)") }
        }
        catch {
            if ((Get-CtgProp $Config 'procureIfUnavailable') -and (Test-CtgSpanningSeatError $_.Exception.Message)) {
                $actions.Add("WARN no available Spanning $type seats — license NOT swapped for $email. Open a Procurement Case to order an Archive seat, then re-run this step.")
            }
            else { throw }
        }
    }

    [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgSpanning {
    <#
    .SYNOPSIS
        Post-action read-back (GET /users/{email}). No mutations; returns { ok; checks[] }.
        Honors the SAME config flags the executors honor, so a deliberately-benign executor branch
        (assignLicense=false, user never in Spanning) doesn't produce a permanent validation miss.
        onboard  -> user present AND licensed=true (skipped entirely when assignLicense=false).
        offboard -> user absent = pass (nothing to retain); present -> archived/removed per config.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $found = Find-CtgSpanningUser -Email $User.UserPrincipalName

    if ($Action -eq 'offboard') {
        if (-not $found) {
            # Spanning never deletes data on offboard, so an absent user means they were never in
            # Spanning — nothing to retain or convert. That's a pass, not a miss.
            $check = @{ name = 'Spanning user absent — nothing to retain'; expected = $true; actual = $true; pass = $true }
            return [pscustomobject]@{ ok = $true; checks = @($check) }
        }
        $checks = @(@{ name = 'Spanning backups retained (user present)'; expected = $true; actual = $true; pass = $true })
        if ((Get-CtgProp $Config 'removeLicense') -or (Get-CtgProp $Config 'unassign')) {
            $lic = Test-CtgSpanningLicensed $found
            $checks += @{ name = 'Spanning license removed'; expected = $false; actual = $lic; pass = (-not $lic) }
        }
        else {
            $swap = Get-CtgProp $Config 'swapLicense'
            $to   = if ($swap) { [string](Get-CtgProp $swap 'to') } else { 'Archive' }
            if ($to -match 'archive') {
                $arch = Test-CtgSpanningArchived $found
                $checks += @{ name = 'Spanning license = Archive'; expected = $true; actual = $arch; pass = $arch }
            }
        }
        return [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
    }

    if ((Get-CtgProp $Config 'assignLicense') -eq $false) {
        $check = @{ name = 'license assignment disabled in config — nothing to verify'; expected = $true; actual = $true; pass = $true }
        return [pscustomobject]@{ ok = $true; checks = @($check) }
    }
    $licensed = [bool]($found -and (Test-CtgSpanningLicensed $found))
    $checks = @(
        @{ name = 'Spanning user present';                       expected = $true; actual = [bool]$found; pass = [bool]$found },
        @{ name = 'Spanning backup enabled (Standard license)';  expected = $true; actual = $licensed;     pass = $licensed }
    )
    [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
}

Export-ModuleMember -Function Connect-CtgSpanning, Invoke-CtgSpanningApi, Test-CtgSpanning404, Test-CtgSpanningSeatError, Test-CtgSpanningLicensed, Test-CtgSpanningArchived, Find-CtgSpanningUser, Set-CtgSpanningLicense, Invoke-CtgSpanningOnboarding, Invoke-CtgSpanningOffboarding, Confirm-CtgSpanning
