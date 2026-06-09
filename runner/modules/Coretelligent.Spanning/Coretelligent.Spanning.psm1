#Requires -Version 7.0

# Coretelligent.Spanning  (Spanning Backup for Microsoft 365 — Kaseya/Spanning)
# Per-user SaaS-backup lifecycle. Onboarding ASSIGNS a Spanning Backup STANDARD license so the new
# user's mailbox/OneDrive/SharePoint is protected; offboarding RETAINS the departed user's backups
# (legal/retention) by swapping them to the ARCHIVE license instead of deleting data.
#
# API: https://api.spanningbackup.com  (verified against the live reference)
#   Base URL  : https://api-{region}.spanningbackup.com/api/v1   (region: US, EU, AP, UK, CA)
#   Auth      : HTTP Basic over HTTPS — username = the client's domain, password = the access token
#               (generated in Spanning Backup's Administrator section).
#   Get user  : GET  /users/{email}            -> { type, email, licensed:bool, archived:bool } | 404
#   Assign    : POST /users/assign   { emails:[..], licenseType:"STANDARD"|"ARCHIVE" } -> { licensed }
#   Unassign  : POST /users/unassign { emails:[..] }                                    -> { licensed }
# Assign/unassign are bulk + idempotent server-side; assigning an already-licensed user returns 200
# with licensed=false ("already had it"). 404 = the user isn't in the caller's domain yet (Spanning
# discovers M365 users on its own schedule — re-run once they appear).

Set-StrictMode -Version Latest

$script:SpanningRegions = @('us', 'eu', 'ap', 'uk', 'ca')
$script:SpanningApiUrl  = 'https://api-us.spanningbackup.com/api/v1'
$script:SpanningDomain  = $null
$script:SpanningToken   = $null

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
        [Parameter(Mandatory)][string]$Domain,        # Basic-auth username (the client's domain)
        [Parameter(Mandatory)][string]$AccessToken,   # Basic-auth password (Spanning access token)
        [string]$Region = 'us',
        [string]$BaseUrl                               # full override, incl. /api/v1, if ever needed
    )
    if ($BaseUrl) {
        # Accept a host with or without the API path: append /api/v1 when it's missing so an operator
        # can store just "https://api-eu.spanningbackup.com" in the secret's apiURL field.
        $u = $BaseUrl.TrimEnd('/')
        if ($u -notmatch '/api/v\d+$') { $u = "$u/api/v1" }
        $script:SpanningApiUrl = $u
    }
    else {
        $r = ([string]$Region).ToLower().Trim()
        if ($script:SpanningRegions -notcontains $r) { $r = 'us' }
        $script:SpanningApiUrl = "https://api-$r.spanningbackup.com/api/v1"
    }
    $script:SpanningDomain = $Domain
    $script:SpanningToken  = $AccessToken
}

function Invoke-CtgSpanningApi {
    # Single HTTP seam (mocked in tests). HTTP Basic: domain:token, base64 in the Authorization header.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:SpanningToken) { throw "Call Connect-CtgSpanning first." }
    $pair = "$($script:SpanningDomain):$($script:SpanningToken)"
    $b64  = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pair))
    $p = @{
        Method      = $Method
        Uri         = "$script:SpanningApiUrl$Path"
        Headers     = @{ Authorization = "Basic $b64" }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    Invoke-RestMethod @p
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

function Test-CtgSpanningSeatError {
    # Is this vendor error an out-of-seats condition (-> procurement warning) rather than a real
    # failure? Require BOTH a license/seat word AND a shortage word, so transient errors like
    # "rate limit exceeded" are NOT swallowed into a procurement note. Defensive — Spanning is
    # usage-billed, so assigns normally just succeed.
    param([Parameter(Mandatory)][string]$Message)
    ($Message -match 'licen[cs]e|seat') -and ($Message -match 'available|limit|exceed|quota|insufficient|out of')
}

function Find-CtgSpanningUser {
    # GET /users/{email}; 404 -> $null (the user isn't in Spanning's domain yet).
    param([Parameter(Mandatory)][string]$Email)
    try { return Invoke-CtgSpanningApi -Method GET -Path "/users/$Email" }
    catch { if (Test-CtgSpanning404 $_) { return $null } throw }
}

function Set-CtgSpanningLicense {
    # POST /users/assign with a license type. Returns the parsed response ({ licensed }).
    param([Parameter(Mandatory)][string]$Email, [Parameter(Mandatory)][ValidateSet('STANDARD', 'ARCHIVE')][string]$LicenseType)
    Invoke-CtgSpanningApi -Method POST -Path '/users/assign' -Body @{ emails = @($Email); licenseType = $LicenseType }
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
        $actions.Add("Spanning has not discovered $email yet (it syncs M365 users on its own schedule) — re-run this step once the user appears to assign the backup license")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ((Get-CtgProp $found 'licensed')) {
        $actions.Add("backup already enabled for $email (Standard license already assigned)")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    if ($PSCmdlet.ShouldProcess($email, "assign Spanning Backup Standard license")) {
        try {
            $resp = Set-CtgSpanningLicense -Email $email -LicenseType 'STANDARD'
            # The API reports licensed=true when a license was actually assigned, false when the user
            # "already had a license". Don't claim success the vendor didn't report — the validation
            # read-back checks the licensed flag either way.
            if ((Get-CtgProp $resp 'licensed') -eq $false) {
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
        if ((Get-CtgProp $found 'licensed') -eq $false -and (Get-CtgProp $found 'archived') -eq $false) {
            $actions.Add("Spanning license already removed for $email — no change")
        }
        elseif ($PSCmdlet.ShouldProcess($email, "unassign Spanning license (free the seat)")) {
            Invoke-CtgSpanningApi -Method POST -Path '/users/unassign' -Body @{ emails = @($email) } | Out-Null
            $actions.Add("unassigned Spanning license for $email (seat freed)")
        }
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    $swap = Get-CtgProp $Config 'swapLicense'
    $to   = if ($swap) { [string](Get-CtgProp $swap 'to') } else { 'Archive' }
    $type = if ($to -match 'archive') { 'ARCHIVE' } elseif ($to -match 'standard') { 'STANDARD' } else { 'ARCHIVE' }

    if ($type -eq 'ARCHIVE' -and (Get-CtgProp $found 'archived')) {
        $actions.Add("Spanning license already Archive for $email — no swap needed")
    }
    elseif ($type -eq 'STANDARD' -and (Get-CtgProp $found 'licensed')) {
        $actions.Add("Spanning license already Standard for $email — no swap needed")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "swap Spanning license to $type")) {
        try {
            $resp = Set-CtgSpanningLicense -Email $email -LicenseType $type
            $from = if ($swap) { [string](Get-CtgProp $swap 'from') } else { 'Standard' }
            # The vendor docs leave a tier swap ambiguous: assign returns licensed=false when the user
            # "already had a license", which may mean the tier was NOT converted. Report what the API
            # said; the validation read-back checks the archived flag and will flag a real miss.
            if ((Get-CtgProp $resp 'licensed') -eq $false) {
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
            $lic = [bool](Get-CtgProp $found 'licensed')
            $checks += @{ name = 'Spanning license removed'; expected = $false; actual = $lic; pass = (-not $lic) }
        }
        else {
            $swap = Get-CtgProp $Config 'swapLicense'
            $to   = if ($swap) { [string](Get-CtgProp $swap 'to') } else { 'Archive' }
            if ($to -match 'archive') {
                $arch = [bool](Get-CtgProp $found 'archived')
                $checks += @{ name = 'Spanning license = Archive'; expected = $true; actual = $arch; pass = $arch }
            }
        }
        return [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
    }

    if ((Get-CtgProp $Config 'assignLicense') -eq $false) {
        $check = @{ name = 'license assignment disabled in config — nothing to verify'; expected = $true; actual = $true; pass = $true }
        return [pscustomobject]@{ ok = $true; checks = @($check) }
    }
    $licensed = [bool]($found -and (Get-CtgProp $found 'licensed'))
    $checks = @(
        @{ name = 'Spanning user present';                       expected = $true; actual = [bool]$found; pass = [bool]$found },
        @{ name = 'Spanning backup enabled (Standard license)';  expected = $true; actual = $licensed;     pass = $licensed }
    )
    [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
}

Export-ModuleMember -Function Connect-CtgSpanning, Invoke-CtgSpanningApi, Test-CtgSpanning404, Test-CtgSpanningSeatError, Find-CtgSpanningUser, Set-CtgSpanningLicense, Invoke-CtgSpanningOnboarding, Invoke-CtgSpanningOffboarding, Confirm-CtgSpanning
