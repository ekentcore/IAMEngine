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
        NOTE: the browser portal login may require a DIFFERENT credential than the API (the API secret
        stores clientId/clientSecret). VERIFY which credential the real admin console accepts.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        $Secret
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
    $email   = $User.UserPrincipalName

    # The force-sync signs in to the Spanning ADMIN CONSOLE, which is Microsoft 365 SSO — so it needs a
    # real M365 USER login (an email + that account's password).
    #
    # It must NOT fall back to the API credential. A Spanning API clientId/accessToken is not an M365
    # identity: handing it to Microsoft SSO cannot succeed, produces an unexplained "bad password"
    # (the diagnostic script refuses this for exactly that reason), and repeated automated attempts
    # with a wrong password are how you get an account locked out. If no portal login is brokered we
    # say so plainly and leave the sync to a human — a WARN, never a case failure.
    # Portal fields first, then the generic Username/Password PAIR (a perfectly normal place to keep a
    # portal login). What we must never do is read the API-CREDENTIAL names — ClientID / Access Token /
    # API Key / ClientSecret — which is what previously let a Spanning API key be typed into Microsoft's
    # sign-in box: it can't authenticate, and repeated attempts are how the admin account gets locked.
    #
    # Sources are taken as PAIRS, never mixed: a portal username must not end up beside a password
    # picked from somewhere else. The email check below is the backstop — an API clientId isn't an email.
    $username = Get-CtgSpanningSecretField $Secret @('PortalUsername', 'AdminUser', 'AdminEmail')
    $password = Get-CtgSpanningSecretField $Secret @('PortalPassword', 'AdminPassword')
    if (-not $username -and -not $password) {
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
    if (-not $username -or -not $password) {
        $actions.Add("WARN could not force a Spanning sync for $email — the Spanning secret has no PORTAL login. Add PortalUsername (an M365 admin's email) + PortalPassword to the Delinea secret, and enable One-Time Password on it for the MFA prompt. The API clientId/token CANNOT be used to sign in to the console. Trigger the sync manually meanwhile.")
        return [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    # An M365 sign-in name is an email/UPN. Anything else is almost certainly an API clientId that got
    # dropped into a portal slot — refuse it rather than burn a failed sign-in against the account.
    #
    # The rejected VALUE is never echoed: by this guard's own premise it is credential material out of
    # Delinea, and every action here lands in an AuditLog row and a ServiceNow work note (CLAUDE.md:
    # secrets never live in the app). Naming the field is enough for an operator to fix it.
    if ($username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        $actions.Add("WARN could not force a Spanning sync for $email — the brokered portal username is not an email/UPN, so it cannot be an M365 sign-in (an API clientId in the PortalUsername slot?). Set PortalUsername on the Delinea secret to an M365 admin's email address. The value is not repeated here because it may be credential material.")
        return [pscustomobject]@{ System = 'spanning-force-sync'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

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

Export-ModuleMember -Function Connect-CtgSpanning, Invoke-CtgSpanningApi, Test-CtgSpanning404, Test-CtgSpanningSeatError, Test-CtgSpanningLicensed, Test-CtgSpanningArchived, Find-CtgSpanningUser, Set-CtgSpanningLicense, Invoke-CtgSpanningOnboarding, Invoke-CtgSpanningOffboarding, Confirm-CtgSpanning, Get-CtgSpanningSecretField, Invoke-CtgSpanningForceSync
