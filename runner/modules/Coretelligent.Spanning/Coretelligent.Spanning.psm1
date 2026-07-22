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
        # Force HTTPS: a scheme-less host ("o365-api-us.spanningbackup.com") or an "http://" apiURL
        # would make Invoke-RestMethod default to port 80 and hang to the TCP timeout (see the
        # Proofpoint wedge). Spanning is HTTPS-only, so normalize regardless of what's stored.
        if ($u -match '^http://')       { $u = 'https://' + $u.Substring(7) }
        elseif ($u -notmatch '^https://') { $u = "https://$u" }
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
        $matches = @($list) | Where-Object {
            ([string](Get-CtgProp $_ 'email')).ToLower() -eq $needle -or
            ([string](Get-CtgProp $_ 'userPrincipalName')).ToLower() -eq $needle
        }
        # Prefer an ACTIVE record, but fall back to an inactive (isDeleted) one — the user IS in
        # Spanning, just deactivated; onboarding reactivates them rather than waiting forever for a
        # "discovery" that already happened.
        $hit = @($matches | Where-Object { -not (Get-CtgProp $_ 'isDeleted') } | Select-Object -First 1)
        if (-not $hit) { $hit = @($matches | Select-Object -First 1) }
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
    $inactive = [bool](Get-CtgProp $found 'isDeleted')
    if ((Test-CtgSpanningLicensed $found) -and -not $inactive) {
        $actions.Add("backup already enabled for $email (Standard license already assigned)")
        return [pscustomobject]@{ System = 'spanning'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ($inactive) {
        # The user exists in Spanning but is deactivated/inactive. Spanning's API has no explicit
        # "reactivate" — assigning a Standard license is what brings the user back to active + backed up.
        $actions.Add("$email exists in Spanning but is INACTIVE — assigning a Standard license to reactivate and enable backup")
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
            elseif ($inactive -and (Test-CtgSpanning404 $_)) {
                # Soft-deleted users can usually be re-licensed; a 404 here means Spanning won't take
                # the assign while the user is deactivated — needs a manual reactivation first.
                throw "Spanning rejected the license assign for $email — the user is INACTIVE in Spanning and the API has no reactivate endpoint. Reactivate them in the Spanning admin console, then re-run this step."
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
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Spanning assignments are keyed by email — a bare display name would report a false "not found"
    # success on an offboard, so no email is an error, not a silent no-op.
    $email   = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "spanning: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

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
            $reported = ((Get-CtgProp $resp 'licensed') ?? (Get-CtgProp $resp 'assigned'))
            # PROVE the swap instead of assuming it. Kaseya's API cannot CONVERT a Standard license to
            # an Archive one — "Standard licenses cannot be converted to archived licenses" — so an
            # /users/assign {licenseType:ARCHIVE} against a user who already holds Standard is a no-op,
            # and licensed=false is exactly how the vendor says so. This code used to log a reassuring
            # "the read-back will confirm it" line and return Status=ok, so every Spanning offboard
            # reported success while quietly leaving the leaver on a BILLABLE, still-backing-up seat.
            # Re-read the tier and tell the truth about what we find.
            $after = Find-CtgSpanningUser -Email $email
            if ($after -and (Test-CtgSpanningArchived $after)) {
                $actions.Add("swapped Spanning license: $from -> $to (kept an archive seat for retention)")
            }
            else {
                # The backups are safe (nothing here deletes them) — but the seat is still Standard.
                # Deliberately NOT auto-unassigning to force it: Kaseya warns that deactivating a
                # license can lead to backup data deletion, and the whole point of this step is
                # retention. So: say it plainly and hand it to a human, rather than claim success.
                $actions.Add("WARN Spanning license NOT swapped to $to for $email — the user is still on a billable STANDARD seat (Spanning reported licensed=$reported and the read-back still shows Standard). Kaseya's API cannot convert Standard -> Archive. The backups are retained and safe. ARCHIVE IT BY HAND: Spanning admin console -> Manage Licenses -> select $email -> Activate Archived. Then re-run this step to confirm.")
            }
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
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "never in Spanning" and would rubber-stamp
    # an offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $found = Find-CtgSpanningUser -Email $email

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

function Get-CtgSpanningSecretField {
    # Field-synonym picker over a brokered secret's Fields hashtable (the $pick pattern used across
    # the modules). Returns the first non-empty value among $Names, else $null. StrictMode-safe.
    param($Secret, [Parameter(Mandatory)][string[]]$Names)
    if (-not $Secret) { return $null }
    $fields = Get-CtgProp $Secret 'Fields'
    foreach ($n in $Names) {
        if ($fields -and ($fields -is [System.Collections.IDictionary]) -and $fields.ContainsKey($n) -and $fields[$n]) { return $fields[$n] }
    }
    return $null
}

function Resolve-CtgSpanningPortalLogin {
    <#
    .SYNOPSIS
        The ONE place that decides what may be typed into Microsoft's sign-in box for the Spanning
        admin console. Returns @{ Ok; Username; Password; Reason }.
    .DESCRIPTION
        Shared by the force-sync and by its connection test, deliberately: the test's whole value is
        that it proves THE credential production will use, resolved THE way production resolves it. A
        second, parallel implementation could go green on a credential the real sync then chokes on.

        The console is Microsoft 365 SSO, so this must be a real M365 user login (an email + that
        account's password). It must NOT fall back to the API credential: a Spanning clientId /
        access-token is not an M365 identity, cannot authenticate, and repeated automated attempts with
        a wrong password are how a real admin account gets locked out. So the API-credential field names
        (ClientID / ClientSecret / Access Token / API Key) are never read here, and the email check is
        the backstop — an API clientId is not an email.

        Username and password are taken as a PAIR from one source, never mixed: a portal username must
        not end up beside a password picked from somewhere else (that too is just a failed sign-in).
    #>
    param($Secret, [string]$SecretName = 'spanning-portal')

    $username = Get-CtgSpanningSecretField $Secret @('PortalUsername', 'AdminUser', 'AdminEmail')
    $password = Get-CtgSpanningSecretField $Secret @('PortalPassword', 'AdminPassword')
    if (-not $username -and -not $password) {
        # On a DEDICATED spanning-portal secret the generic pair is the natural place for the login —
        # and it is unambiguous there, because that secret holds no API credential to confuse it with.
        $username = Get-CtgSpanningSecretField $Secret @('Username', 'User', 'Email')
        $password = Get-CtgSpanningSecretField $Secret @('Password')
    }
    # A pscredential is a username+password pair by construction — a legitimate portal-login shape.
    if (-not $username -and -not $password) {
        $cred = Get-CtgProp $Secret 'Credential'
        if ($cred) {
            $username = $cred.UserName
            try { $password = $cred.GetNetworkCredential().Password } catch { }
        }
    }

    # Name the RIGHT fix for how this client is wired: no portal secret at all (we fell back to the API
    # secret, which can never sign in) vs. a portal secret present but missing its username/password.
    $fellBack = ($SecretName -eq 'spanning')
    if (-not $username -or -not $password) {
        $fix = if ($fellBack) {
            "this client has no 'spanning-portal' secret, so the sign-in fell back to the API credential, which CANNOT sign in to the console. Wire a 'spanning-portal' secret (Username = an M365 admin's email, Password = that account's password)"
        } else {
            "the 'spanning-portal' secret has no Username/Password"
        }
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "no portal login is available: $fix, and enable One-Time Password on it so Delinea can supply the MFA code. See /help/spanning." }
    }
    # The rejected VALUE is never echoed: by this guard's own premise it is credential material out of
    # Delinea, and everything here lands in an AuditLog row and a ServiceNow work note (CLAUDE.md:
    # secrets never live in the app). Naming the field is enough for an operator to fix it.
    if ($username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        $why = if ($fellBack) {
            "this client has no 'spanning-portal' secret, so the API credential was used and its clientId is not an email"
        } else {
            "the 'spanning-portal' secret's Username is not an email (an API clientId in the portal slot?)"
        }
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "the brokered portal username is not an email/UPN, so it cannot be an M365 sign-in: $why. Set the 'spanning-portal' secret's Username to an M365 admin's email address. The value is not repeated here because it may be credential material." }
    }
    [pscustomobject]@{ Ok = $true; Username = $username; Password = $password; Reason = $null }
}

function Test-CtgSpanningPortalLogin {
    <#
    .SYNOPSIS
        Connection test for the Spanning ADMIN CONSOLE sign-in: drives the real browser flow through
        Microsoft SSO + MFA and stops once the console is reached. Triggers NO sync.
    .DESCRIPTION
        Returns @{ Ok; Detail }. Never throws — the caller reports it as one rights row, so a portal
        problem can never fail the Spanning API (licensing) test that runs alongside it.

        This is the only way to learn, BEFORE an onboarding needs it, that the console login is broken:
        a wrong password, an MFA method Delinea can't mint (push/phone rather than a TOTP token),
        Conditional Access blocking the agent's IP, or an admin with no Spanning console access. All
        four are otherwise invisible until a real force-sync fails.

        It runs the SAME flow file as the force-sync (signInOnly) so it can't drift from what production
        does — a bespoke "test login" would prove only that the test's own code works.
    #>
    param($Secret, [string]$SecretName = 'spanning-portal', [hashtable]$OtpRequest)

    $login = Resolve-CtgSpanningPortalLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) { return [pscustomobject]@{ Ok = $false; Detail = $login.Reason } }

    $params = @{ signInOnly = $true }
    if ($OtpRequest) { $params['otp'] = $OtpRequest }
    # Carry the SAME MFA fallbacks the force-sync carries. A client still on a stored TOTP seed (rather
    # than Delinea's one-time password) would otherwise fail the test while the real sync succeeds — a
    # false red on a working setup, which is worse than no test at all.
    $totpSeed = Get-CtgSpanningSecretField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'OTP Seed', 'MFASeed', 'MFA Seed', 'AuthenticatorSeed', 'Authenticator Seed', 'OneTimePasswordSeed', 'TwoFactorSeed', '2FASeed', 'otpauth')
    if ($totpSeed) { $params['totpSeed'] = $totpSeed }
    $flowInput = @{ username = $login.Username; password = $login.Password; params = $params }
    # Same budget as the force-sync's sign-in leg: browser launch + the SSO hop + an MFA wait.
    $res = Invoke-CtgBrowserFlow -Flow 'spanning-force-sync' -InputObject $flowInput -TimeoutSeconds 240
    if ($res -and $res.ok) {
        return [pscustomobject]@{ Ok = $true; Detail = "signed in to the Spanning console via Microsoft 365 SSO as $($login.Username)" }
    }
    $err = if ($res -and $res.error) { [string]$res.error } else { 'the browser flow returned no result' }
    [pscustomobject]@{ Ok = $false; Detail = $err }
}

function Invoke-CtgSpanningForceSync {
    <#
    .SYNOPSIS
        On-demand "force Spanning sync": drive the Spanning admin portal (headless browser, via the
        Coretelligent.Browser sidecar) to trigger a directory/user scan so a just-created M365 user is
        discovered NOW instead of on Spanning's own schedule. The Spanning API has no sync endpoint —
        this is the last-resort browser executor. Ad-hoc (dispatched on demand from the Spanning step),
        never part of a plan; idempotent (triggering a scan twice is harmless).
    .DESCRIPTION
        Builds the portal login from the brokered Spanning secret (Username/Password via the field
        synonyms) + the target email, runs the 'spanning-force-sync' browser flow, and maps the result
        to the runner's result contract:
          success            -> Status ok, a "triggered" action line (verified);
          queued/async       -> RetryAfterMinutes so the app re-checks the Spanning license shortly (retrying);
          browser missing /
          portal failure /
          MFA required        -> a WARN action line (warning) — never a hard throw, since a convenience
                                  sync shouldn't fail the case; the operator can sync manually.
        CREDENTIAL: the console is Microsoft 365 SSO, so this needs an INTERACTIVE M365 admin sign-in —
        a different credential from the API's clientId/clientSecret. It is brokered as its own secret,
        'spanning-portal' (see AUXILIARY_SECRETS in web/lib/orchestrator.ts), so that licensing (pure
        API, both lanes) keeps working for clients that never wire a portal login. Splitting them also
        removes the footgun of an M365 password sitting in the API secret's Username/Password fields,
        where Use-CtgSpanningSecret would try to authenticate with it as clientId:clientSecret.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        $Secret
        ,
        # Which brokered secret $Secret came from — used ONLY to make the "wire a portal login" guidance
        # name the right Delinea entry. 'spanning' means we fell back to the API secret (a client wired
        # before the portal secret existed), which cannot sign in — the guards below say so.
        [string]$SecretName = 'spanning-portal'
        ,
        # PREFERRED: @{ url; token; agentId; secretName } — the app endpoint the browser flow calls to
        # mint a Delinea one-time password AT THE MFA PROMPT. A TOTP code lives ~30s; browser launch +
        # portal load + the SSO hop routinely exceed that, so any code fetched before the browser
        # starts is stale on arrival. Passed through to the flow, never invoked here.
        [hashtable]$OtpRequest
        ,
        # LEGACY: closure returning @{ Code; RemainingSeconds } from Delinea, invoked here (pre-mint,
        # subject to the staleness above). Used only when -OtpRequest is absent; kept so tests can
        # drive the MFA path without a vault and older dispatch wiring keeps working.
        [scriptblock]$OtpProvider
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    # StrictMode-safe identity read — this runs on the OFFBOARD lane too, where the payload may carry
    # no UserPrincipalName property at all (a ServiceNow UM intake carries `userToOffboard`).
    $email   = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "spanning: the case carries no email/UPN for the user to sync — set the user's email on the case and re-run." }

    $login = Resolve-CtgSpanningPortalLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) {
        $actions.Add("WARN could not force a Spanning sync for $email — $($login.Reason) Trigger the sync manually meanwhile.")
        return [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $username = $login.Username
    $password = $login.Password

    # MFA. PREFERRED: hand the flow an OTP REQUEST SPEC so the sidecar mints the Delinea code at the
    # moment the MFA box is visible — Delinea holds the authenticator seed (one-time password enabled
    # on the secret) and the seed never reaches us. LEGACY: pre-mint via -OtpProvider (stale-prone).
    $otpCode = $null
    if (-not $OtpRequest -and $OtpProvider) {
        $otp = & $OtpProvider
        if ($otp -and $otp.Code) {
            $otpCode = [string]$otp.Code
            $actions.Add("fetched a one-time password from Delinea ($($otp.RemainingSeconds)s valid)")
        }
    }
    if ($OtpRequest) { $actions.Add("one-time password will be minted by Delinea at the MFA prompt") }
    # LEGACY fallback: a TOTPSeed field on the secret. Storing a PERMANENT seed where a 30-second code
    # would do is strictly worse — prefer enabling One-Time Password on the Delinea secret instead.
    # Passed alongside the request spec: the flow only reaches for it when no code can be minted.
    $totpSeed = Get-CtgSpanningSecretField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'OTP Seed', 'MFASeed', 'MFA Seed', 'AuthenticatorSeed', 'Authenticator Seed', 'OneTimePasswordSeed', 'TwoFactorSeed', '2FASeed', 'otpauth')
    if ($totpSeed -and -not $OtpRequest -and -not $otpCode) { $actions.Add("WARN using a stored TOTP seed — enable One-Time Password on the Delinea secret instead, so the seed never leaves the vault") }

    $params = @{ email = $email }
    if ($OtpRequest) { $params['otp']      = $OtpRequest }
    if ($otpCode)    { $params['otpCode']  = $otpCode }
    if ($totpSeed)   { $params['totpSeed'] = $totpSeed }
    $flowInput = @{ username = $username; password = $password; params = $params }
    # -TimeoutSeconds 420, NOT the 180s default: the flow polls the async sync for up to 2 minutes on
    # top of browser launch + the Microsoft SSO hop + MFA (which can itself wait out a TOTP window) +
    # the redirect back. At the default the child would be KILLED mid-poll and a sync that actually
    # fired would come back as a failure with no retryAfterMinutes — worse than not polling at all.
    # See the INVARIANT note on pollMs() in flows/spanning-force-sync.mjs; keep the two in step.
    $res = Invoke-CtgBrowserFlow -Flow 'spanning-force-sync' -InputObject $flowInput -TimeoutSeconds 420

    if ($res.ok) {
        $msg = if ($res.message) { $res.message } else { "triggered a Spanning directory sync for $email" }
        $actions.Add($msg)
        $out = [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
        if ($null -ne $res.retryAfterMinutes -and $res.retryAfterMinutes -gt 0) {
            $actions.Add("sync is asynchronous — re-checking whether Spanning has discovered $email in $($res.retryAfterMinutes) minutes")
            # RetryAfterMinutes: the app re-queues this job automatically (capped) — see sweepAutoRetries.
            $out = [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray(); RetryAfterMinutes = $res.retryAfterMinutes }
        }
        return $out
    }

    # Not ok — surface as a WARN (warning verdict), including any screenshot evidence path.
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
    $actions.Add("WARN Spanning force-sync could not complete for $email — $err$ev")
    [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgSpanningConsoleSetup {
    <#
    .SYNOPSIS
        Browser auto-setup for the Spanning API credential: sign into the Spanning admin console (M365
        SSO) and generate + HARVEST the Settings → API Token, returning it note-only for the app to
        vault as the `spanning` secret. The setup analog of Invoke-CtgSpanningForceSync — SAME portal
        login (spanning-portal secret, M365 SSO), same OTP-at-the-prompt machinery — but it reads the
        API key instead of triggering a sync.
    .DESCRIPTION
        Unlike force-sync (a convenience that soft-warns on failure), a SETUP that cannot harvest the
        token THROWS, so the job fails and the app surfaces "did not complete" rather than silently
        vaulting nothing. The harvested token rides a `Credentials` note-property the app scrubs after
        vaulting; it is never logged here. LIVE-VALIDATION PENDING — the post-login Settings → API Token
        selectors (flows/spanning-console-setup.mjs) are best-effort against an unreachable console.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$Config,
        $Secret,
        [string]$SecretName = 'spanning-portal',
        [hashtable]$OtpRequest,
        [scriptblock]$OtpProvider
    )
    $login = Resolve-CtgSpanningPortalLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) { throw "Spanning console setup: $($login.Reason)" }

    $signInOnly = [bool](Get-CtgProp $Config 'signInOnly')
    $params = @{ signInOnly = $signInOnly }
    $consoleUrl = Get-CtgProp $Config 'consoleUrl'
    if ($consoleUrl) { $params['consoleUrl'] = $consoleUrl }
    if ($OtpRequest) { $params['otp'] = $OtpRequest }
    elseif ($OtpProvider) {
        $otp = & $OtpProvider
        if ($otp -and $otp.Code) { $params['otpCode'] = [string]$otp.Code }
    }
    $totpSeed = Get-CtgSpanningSecretField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'MFASeed', 'AuthenticatorSeed', 'otpauth')
    if ($totpSeed -and -not $OtpRequest) { $params['totpSeed'] = $totpSeed }

    $flowInput = @{ username = $login.Username; password = $login.Password; params = $params }
    $res = Invoke-CtgBrowserFlow -Flow 'spanning-console-setup' -InputObject $flowInput -TimeoutSeconds 300

    if (-not $res.ok) {
        $err = if ($res.error) { $res.error } else { 'unknown error' }
        $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
        throw "Spanning console setup did not complete: $err$ev"
    }
    if ($signInOnly) {
        return [pscustomobject]@{ System = 'spanning-console-setup'; Status = 'ok'; Actions = @('Spanning console sign-in test succeeded (no changes made)') }
    }
    $token = $null
    if ($res.Credentials) { $token = [string]$res.Credentials.apiToken }
    if (-not $token) { throw 'Spanning console setup: signed in but no API token was harvested from the console' }
    # The token rides a Credentials note-property (never logged); the app vaults it then scrubs the result.
    [pscustomobject]@{
        System      = 'spanning-console-setup'
        Status      = 'ok'
        Actions     = @('created/read the Spanning API Token in the admin console and harvested it for vaulting')
        Credentials = [pscustomobject]@{ apiToken = $token }
    }
}

Export-ModuleMember -Function Connect-CtgSpanning, Invoke-CtgSpanningApi, Test-CtgSpanning404, Test-CtgSpanningSeatError, Test-CtgSpanningLicensed, Test-CtgSpanningArchived, Find-CtgSpanningUser, Set-CtgSpanningLicense, Invoke-CtgSpanningOnboarding, Invoke-CtgSpanningOffboarding, Confirm-CtgSpanning, Get-CtgSpanningSecretField, Invoke-CtgSpanningForceSync, Invoke-CtgSpanningConsoleSetup, Resolve-CtgSpanningPortalLogin, Test-CtgSpanningPortalLogin
