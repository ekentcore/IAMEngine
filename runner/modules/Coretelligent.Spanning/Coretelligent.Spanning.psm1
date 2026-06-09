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
    return ($ErrorRecord.Exception.Message -match '\b404\b|not found|does not exist|not exist')
}

function Find-CtgSpanningUser {
    # GET /users/{email}; 404 -> $null (the user isn't in Spanning's domain yet).
    param([Parameter(Mandatory)][string]$Email)
    try { return Invoke-CtgSpanningApi -Method GET -Path "/users/$Email" }
    catch { if (Test-CtgSpanning404 $_) { return $null } throw }
}

# Vendor messages that would mean "out of seats". Spanning is usage-billed (assign normally just
# succeeds), so this guard is defensive — it converts any seat/quota error into a procurement
# warning instead of failing the case.
$script:SpanningNoSeats = 'available licenses|no available|out of|limit|exceeded|no seats|quota|insufficient'

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
            Set-CtgSpanningLicense -Email $email -LicenseType 'STANDARD' | Out-Null
            $actions.Add("assigned Spanning Backup Standard license — backup enabled for $email")
        }
        catch {
            if ((Get-CtgProp $Config 'procureIfUnavailable') -and $_.Exception.Message -match $script:SpanningNoSeats) {
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
            Set-CtgSpanningLicense -Email $email -LicenseType $type | Out-Null
            $from = if ($swap) { [string](Get-CtgProp $swap 'from') } else { 'Standard' }
            $actions.Add("swapped Spanning license: $from -> $to (kept an archive seat for retention)")
        }
        catch {
            if ((Get-CtgProp $Config 'procureIfUnavailable') -and $_.Exception.Message -match $script:SpanningNoSeats) {
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
        onboard  -> user present AND licensed=true (Standard backup enabled).
        offboard -> backups retained (user still present) AND, for a swap-to-Archive, archived=true.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $found = Find-CtgSpanningUser -Email $User.UserPrincipalName

    if ($Action -eq 'offboard') {
        $checks = @(@{ name = 'Spanning backups retained (user present)'; expected = $true; actual = [bool]$found; pass = [bool]$found })
        if ((Get-CtgProp $Config 'removeLicense') -or (Get-CtgProp $Config 'unassign')) {
            $lic = [bool]($found -and (Get-CtgProp $found 'licensed'))
            $checks += @{ name = 'Spanning license removed'; expected = $false; actual = $lic; pass = (-not $lic) }
        }
        else {
            $swap = Get-CtgProp $Config 'swapLicense'
            $to   = if ($swap) { [string](Get-CtgProp $swap 'to') } else { 'Archive' }
            if ($to -match 'archive') {
                $arch = [bool]($found -and (Get-CtgProp $found 'archived'))
                $checks += @{ name = 'Spanning license = Archive'; expected = $true; actual = $arch; pass = $arch }
            }
        }
        return [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
    }

    $licensed = [bool]($found -and (Get-CtgProp $found 'licensed'))
    $checks = @(
        @{ name = 'Spanning user present';                       expected = $true; actual = [bool]$found; pass = [bool]$found },
        @{ name = 'Spanning backup enabled (Standard license)';  expected = $true; actual = $licensed;     pass = $licensed }
    )
    [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
}

Export-ModuleMember -Function Connect-CtgSpanning, Invoke-CtgSpanningApi, Test-CtgSpanning404, Find-CtgSpanningUser, Set-CtgSpanningLicense, Invoke-CtgSpanningOnboarding, Invoke-CtgSpanningOffboarding, Confirm-CtgSpanning
