#Requires -Version 7.0

# Coretelligent.SharePoint
# Shared system module — written once, reused by every client.
# App-only SharePoint/OneDrive access via PnP.PowerShell, reusing the m365-admin certificate (the
# same CertificateBase64/Thumbprint the EXO lane uses). Requires the app registration to hold the
# SharePoint-resource Sites.FullControl.All application role. Fail-soft: PnP.PowerShell is an
# optional dependency (see Install-CtgPnPModule / $pnpAvail in Start-IamRunner.ps1) — a host with no
# gallery access simply never loads this module, and callers WARN and continue rather than fail the
# whole case.
#
# Public surface:
#   Connect-CtgSharePointPnP          - establish a PnP app-only session from a credential
#   Grant-CtgSharePointSiteAccess     - grant a leaver's manager/delegate full access to their
#                                        OneDrive/SharePoint content (Task 5)
#   Get-CtgOneDriveSiteUrl            - derive a OneDrive site's root URL from its drive webUrl
#                                        (Task 5)
#   Test-CtgOffboardResolved          - did Invoke-CtgM365Offboarding actually resolve+act, vs. an
#                                        ambiguous/no-match/not-found early return? (offboard-review Fix 1)
#   Invoke-CtgSharePointOffboardGrant - the offboard hand-off itself: resolve the delegate name to an
#                                        email/UPN, then grant OneDrive + configured SharePoint sites
#                                        (offboard-review Fix 2)
#   Get-CtgSharePointSiteUrls         - the tenant's sites (not OneDrives/system sites), cached per tenant (FR #118)
#   Invoke-CtgSharePointSiteGroupsOffboard / -Mirror - remove a leaver from / mirror a reference user's
#                                        SITE groups across those sites (FR #118)
#   Invoke-CtgSharePointSiteGroupsStep - the whole sharepoint job: resolve who (the created account, the
#                                        mirror user), then walk the sites; a no-op without a mirror user
#   Test-CtgDelegateUnambiguous       - does a display-name delegate resolve to exactly ONE Entra user?
#                                        fails safe (skip, don't guess) on 2+ matches (offboard-review Fix 5)

Set-StrictMode -Version Latest

# Safe property/key read under StrictMode: $null if the member/key is absent. Mirrors the copy in
# Coretelligent.M365.psm1 — each Coretelligent module keeps its own private copy since these aren't
# exported (a script-scope caller needs its own instance; see Start-IamRunner.ps1's copy too).
function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    # IDictionary (not just [hashtable]) so it also reads the Graph SDK's AdditionalProperties, which
    # is a generic Dictionary[string,object] — [hashtable] alone returned $null for every key there.
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# App-only SharePoint access via PnP.PowerShell, reusing the m365-admin certificate (the same
# CertificateBase64/Thumbprint the EXO lane uses). Requires the app to hold the SharePoint-resource
# Sites.FullControl.All application role. Fail-soft: callers WARN and continue if PnP is unavailable.
function Connect-CtgSharePointPnP {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [string]$CertificateBase64,
        [string]$CertificatePassword,
        [string]$CertificateThumbprint,
        # An already-written .pfx (New-CtgPnPCertFile): a site walk writes the key once, not per site.
        [string]$CertificatePath
    )
    if ($CertificatePath -or $CertificateBase64) {
        $cert = if ($CertificatePath) { @{ Path = $null; CertArgs = @{ CertificatePath = $CertificatePath } } } else { New-CtgPnPCertFile @{ CertificateBase64 = $CertificateBase64 } }
        try {
            $sec = if ($CertificatePassword) { ConvertTo-SecureString ([string]$CertificatePassword) -AsPlainText -Force } else { $null }
            $a = @{ Url = $Url; ClientId = $AppId; Tenant = $Tenant; CertificatePath = $cert.CertArgs['CertificatePath'] }
            if ($sec) { $a['CertificatePassword'] = $sec }
            Connect-PnPOnline @a
        }
        # Only a file written HERE is deleted here — a passed-in path belongs to its caller. Not
        # Remove-Item: under a dry run's global WhatIf it only SAID it deleted the private key.
        finally { Remove-CtgPnPCertFile $cert.Path }
    }
    elseif ($CertificateThumbprint) {
        if (-not $IsWindows) { throw "a CertificateThumbprint only works on a Windows runner — store the cert as CertificateBase64 on the m365-admin secret (cross-platform)." }
        Connect-PnPOnline -Url $Url -ClientId $AppId -Tenant $Tenant -Thumbprint $CertificateThumbprint
    }
    else {
        throw "Connect-CtgSharePointPnP needs app-only cert auth: CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows). The m365-admin secret has neither."
    }
}

# Grant a delegate (e.g. the leaver's manager) SITE-COLLECTION ADMIN on one SharePoint/OneDrive site
# — full access to every item on it, not just what a folder/file-level share would cover. This is why
# the offboard hand-off goes over PnP rather than Graph's drive /invite: Graph has no "make this
# person a site collection admin" call, only per-item permissions.
# Idempotent (checks Get-PnPSiteCollectionAdmin first) and supports -WhatIf/-Confirm. Callers wrap
# this in try/catch and WARN on failure — a SharePoint/PnP problem must never fail the offboard.
function Grant-CtgSharePointSiteAccess {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$SiteUrl,
        [Parameter(Mandatory)][string]$Delegate,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [string]$CertificateBase64,
        [string]$CertificatePassword,
        [string]$CertificateThumbprint
    )
    Connect-CtgSharePointPnP -Url $SiteUrl -AppId $AppId -Tenant $Tenant -CertificateBase64 $CertificateBase64 -CertificatePassword $CertificatePassword -CertificateThumbprint $CertificateThumbprint
    $existing = @(Get-PnPSiteCollectionAdmin -ErrorAction SilentlyContinue)
    # Exact, case-insensitive match on Email or LoginName — NOT -like/substring. A -like "*$Delegate*"
    # match would let an unrelated admin whose email merely CONTAINS the delegate's address (e.g.
    # bsmith@x.com vs. delegate smith@x.com) read as "already admin", silently skipping the grant.
    # LoginName in claims format (i:0#.f|membership|user@x.com) is reduced to the part after the last
    # '|' before comparing.
    $has = $false
    foreach ($a in $existing) {
        $email = [string](Get-CtgProp $a 'Email')
        $login = [string](Get-CtgProp $a 'LoginName')
        $loginId = if ($login -match '\|([^|]+)$') { $Matches[1] } else { $login }
        if (($email -and $email -ieq $Delegate) -or ($loginId -and $loginId -ieq $Delegate)) { $has = $true; break }
    }
    if ($has) { return "$Delegate already a site-collection admin on $SiteUrl — no change" }
    if ($PSCmdlet.ShouldProcess($SiteUrl, "Add $Delegate as site-collection admin")) {
        Add-PnPSiteCollectionAdmin -Owners $Delegate -ErrorAction Stop
        return "granted $Delegate site-collection admin on $SiteUrl"
    }
    return "would grant $Delegate site-collection admin on $SiteUrl (WhatIf)"
}

# Fix 1 (security): the ONLY reliable signal that Invoke-CtgM365Offboarding (Coretelligent.M365.psm1)
# actually resolved a target and ran the teardown — vs. one of its three early "nothing done" returns
# (2+ users share the display name = ambiguous; no exact match but similar candidates exist; or no
# match/candidates at all) — is the UserId property. All three early returns are Status='ok' (not an
# error) and omit UserId entirely; the real teardown path sets it right after `$existing` is resolved,
# before any containment work runs. Granting SharePoint/OneDrive access off an unresolved offboard
# would hand a leaver's site to the delegate for the WRONG person, or for nobody at all.
function Test-CtgOffboardResolved {
    [CmdletBinding()]
    param([AllowNull()][psobject]$OffboardResult)
    if ($null -eq $OffboardResult) { return $false }
    [bool]($OffboardResult.PSObject.Properties['UserId'] -and [string]$OffboardResult.UserId)
}

# Fix 5 (security): a site-collection-admin grant hands the delegate FULL CONTROL of the leaver's
# OneDrive/SharePoint content — Resolve-CtgEntraUser's display-name lookup uses `-Top 1`, so an
# ambiguous name (2+ "Chris Lee"s in the tenant) silently resolves to whichever ONE Graph happens to
# return, and that arbitrary person gets the grant. An email/UPN identifier is already exact
# (Resolve-CtgEntraUser's `@` branch is a `userPrincipalName eq / mail eq` filter, not a name match), so
# only bare display names need the check. Fail-soft: a lookup error here means "cannot confirm
# unambiguous" -> $false, so the caller skips and WARNs rather than granting off an error. Kept as its
# own function (not inlined) so it's unit-testable on its own.
function Test-CtgDelegateUnambiguous {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Identity)
    $id = ([string]$Identity).Trim()
    if (-not $id) { return $false }
    if ($id -match '@') { return $true }   # exact identifier — no ambiguity possible
    try {
        $esc = $id -replace "'", "''"
        $hits = @(Get-MgUser -Filter "displayName eq '$esc'" -Top 2 -ConsistencyLevel eventual -ErrorAction Stop)
        return (@($hits).Count -le 1)
    }
    catch {
        return $false
    }
}

# Offboard hand-off (Task 5): grant the case's named delegate (e.g. the leaver's manager) full access
# to the leaver's OneDrive site, plus any additional profile-configured SharePoint sites, via PnP
# app-only auth. Factored out of Start-IamRunner.ps1's m365 Offboard dispatch block so it's unit
# testable — Start-IamRunner.ps1 has a mandatory param block and a main polling loop, so it can't be
# dot-sourced for Pester (see runner/tests/ConnectionCache.Tests.ps1's header comment).
#
# Callers (dispatch) are expected to have ALREADY confirmed the offboard resolved
# (Test-CtgOffboardResolved) and PnP.PowerShell is available before calling this — this function does
# not re-check either, so it can be exercised directly against a resolved-offboard scenario.
#
# Fix 2: oneDriveGrantAccessTo may be a DISPLAY NAME (a ServiceNow intake field, not necessarily an
# email/UPN), and Add-PnPSiteCollectionAdmin -Owners needs an email/UPN — a bare display name silently
# fails to resolve to a real principal. Resolve it via Resolve-CtgEntraUser ONCE here, the same way the
# Graph /invite delegate-access path in Invoke-CtgM365Offboarding already resolves it
# (Resolve-CtgEntraUser -> Mail ?? UserPrincipalName). Fail-soft: an unresolvable delegate WARNs and
# skips rather than handing PnP a name it cannot use.
function Invoke-CtgSharePointOffboardGrant {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$Job,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{},
        # The seam that actually performs the PnP grants. Defaults to the out-of-process runner, which
        # is the whole point of the fix; a test supplies its own so the grant logic can be exercised
        # without spawning pwsh or owning PnP. Called as: & $GrantInvoker $grants $appId $tenant $certArgs
        [scriptblock]$GrantInvoker = { param($g, $a, $t, $c) Invoke-CtgPnPGrantOutOfProcess -Grants $g -AppId $a -Tenant $t -CertArgs $c }
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $grants = [System.Collections.Generic.List[hashtable]]::new()
    # FR #0000084 widened the case-requested delegate from ONE person to several, and this reader was
    # missed: [string] on an ARRAY joins its elements with a space, so two delegates became one
    # nonexistent person ("Rachel Thompson Nicole Hayes") and the grant WARNed instead of running
    # (FR #0000120 — UM0030521, where the mailbox side worked and this did not). Same normalisation the
    # M365 and Exchange modules use: @(...) accepts a string OR an array and yields one code path.
    $spDelegates = @(@(Get-CtgProp $Job.config 'oneDriveGrantAccessTo') | ForEach-Object { [string]$_ } | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    if (-not $spDelegates.Count) { return $actions.ToArray() }

    # The leaver's OneDrive site is the same for every delegate, so resolve it ONCE rather than per
    # name — it costs a Graph read and a drive lookup each time.
    $odSiteUrl = $null
    try {
        $leaverUpn = Resolve-CtgM365Upn -User $Job.payload
        $drive = if ($leaverUpn) { Get-CtgUserDrive -UserId $leaverUpn } else { $null }
        $odSiteUrl = if ($drive) { Get-CtgOneDriveSiteUrl $drive.WebUrl } else { $null }
    }
    catch {
        $emsg = try { $ge = Get-CtgGraphError $_; "$($ge.Code) $($ge.Message)".Trim() } catch { $_.Exception.Message }
        $actions.Add("WARN could not locate the leaver's OneDrive site: $emsg")
    }

    # Each delegate is INDEPENDENT: an unresolvable or ambiguous name warns about THAT name and the
    # loop carries on, so one bad row cannot cost the other named people their access. Same rule the
    # mailbox and OneDrive-invite paths already follow.
    $extraSites = @(Get-CtgProp $Job.config 'sharePointDelegateSites' | Where-Object { $_ })
    foreach ($spDelegate in $spDelegates) {
        $dUser = Resolve-CtgEntraUser -Identity $spDelegate
        $delegateEmail = if ($dUser) { [string]((Get-CtgProp $dUser 'Mail') ?? (Get-CtgProp $dUser 'UserPrincipalName')) } else { $null }
        if (-not $delegateEmail) {
            $actions.Add("WARN could not grant SharePoint/OneDrive access — the delegate '$spDelegate' was not found in Entra; grant it by hand")
            continue
        }

        # Fix 5 (security): re-check the ORIGINAL delegate value (not the already-resolved email) for
        # display-name ambiguity before granting anything — a site-collection-admin grant is
        # high-privilege, so this path fails safe (skip + WARN) rather than handing full site control
        # to a guessed person.
        if (-not (Test-CtgDelegateUnambiguous -Identity $spDelegate)) {
            $actions.Add("WARN SharePoint hand-off skipped — delegate '$spDelegate' matches multiple users; grant site access by hand")
            continue
        }

        # COLLECT, don't grant. Every PnP call is deferred to one child process below, so this loop —
        # which is all Graph — cannot pull PnP's assemblies into the runner. See
        # Invoke-CtgPnPGrantOutOfProcess for why that matters.
        if ($odSiteUrl) {
            $grants.Add(@{ SiteUrl = $odSiteUrl; Delegate = $delegateEmail; Label = "$delegateEmail SharePoint access to the leaver's OneDrive site" })
        }

        # Any additional profile-configured SharePoint sites (string[] of site URLs) — same resolved
        # delegate, one grant per site.
        foreach ($site in $extraSites) {
            $grants.Add(@{ SiteUrl = $site; Delegate = $delegateEmail; Label = "$delegateEmail access to SharePoint site '$site'" })
        }
    }

    # One child for ALL grants: the cost here is process start plus a PnP import, so paying it per
    # delegate-site pair would be the expensive way to do the same thing.
    if ($grants.Count -gt 0) {
        try { foreach ($a in (& $GrantInvoker $grants.ToArray() $AppId $Tenant $CertArgs)) { $actions.Add([string]$a) } }
        catch { $actions.Add("WARN the SharePoint/OneDrive grants did not run: $($_.Exception.Message)") }
    }
    $actions.ToArray()
}

# ── FR #118: SharePoint SITE groups across every site in the tenant ─────────────────────────────────
# A site's own groups (Owners / Members / Visitors and any custom ones) are SharePoint's, not Entra's,
# so neither the m365 lane nor AD touches them. Offboard removes the leaver from every site group they
# are in; onboard with "mirror <user>" adds the new user to the reference user's site groups.
#
# "Every site" is the scope the FR owner chose. Two things keep it affordable on a big tenant:
#   - the tenant's site list is cached per tenant (6 h) — it changes rarely, and listing it is one
#     admin-centre call that would otherwise repeat on every case;
#   - per site, ONE lookup (Get-PnPUser) says whether the person has ever been on it (the site's user
#     information list). Sites where they never appeared are skipped without enumerating groups.
#
# What a site walk must never do (PR #111 review): read an ERROR as "not on this site". A throttled or
# denied lookup used to come back empty, the site was skipped, and an offboard reported success while
# the leaver kept their access there. Now only a genuine "user not found" is a skip; throttling
# (429/503) is retried with a back-off; anything else fails the site, the walk carries on, and the step
# fails at the end naming every site it could not finish — after doing everything it could.
$script:CtgSiteCache = @{}
$script:CtgSiteCacheHours = 6
# Back-off (seconds) between retries of a throttled site. SharePoint's own guidance is to back off and
# retry; three waits cover a minute-plus of throttling before the site is reported as failed.
$script:CtgSpRetryDelays = @(10, 30, 60)
# Narrate the walk at least this often (sites / seconds) — the runner's stall watchdog restarts a
# process that has said nothing for 600 s, and a big tenant takes far longer than that to walk.
$script:CtgSpProgressEverySites = 10
$script:CtgSpProgressEverySeconds = 30

function ConvertTo-CtgClaimsLogin {
    param([Parameter(Mandatory)][string]$Email)
    "i:0#.f|membership|$Email"
}

# Narrate into the live run-report progress (Send-CtgProgress is the runner's global poster, which
# also touches the stall watchdog's heartbeat; absent in a bare module import).
function Write-CtgSharePointStep {
    param([string]$Message)
    if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress $Message }
}

# Materialise a CertificateBase64 ONCE as a temp .pfx and return CertArgs that point at it, so a walk
# over hundreds of sites writes the private key to disk once, not once per site. The caller deletes it
# with Remove-CtgPnPCertFile in a finally. Thumbprint / already-materialised args pass through untouched
# (Path = $null, nothing to delete).
function New-CtgPnPCertFile {
    param([hashtable]$CertArgs = @{})
    $b64 = [string]$CertArgs['CertificateBase64']
    if (-not $b64) { return @{ CertArgs = $CertArgs; Path = $null } }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-pnp-" + [guid]::NewGuid().ToString('N') + ".pfx")
    [System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(($b64 -replace '\s', '')))
    $a = @{ CertificatePath = $tmp }
    if ($CertArgs['CertificatePassword']) { $a['CertificatePassword'] = [string]$CertArgs['CertificatePassword'] }
    @{ CertArgs = $a; Path = $tmp }
}

# [IO.File]::Delete, not Remove-Item: a dry run sets the global WhatIf preference, and Remove-Item
# honours it — which left the private key behind in the temp folder on every dry run.
function Remove-CtgPnPCertFile {
    param([string]$Path)
    if ($Path) { try { [System.IO.File]::Delete($Path) } catch { } }
}

# The messages across an exception's InnerException chain — PnP wraps the HTTP status a level or two down.
function Get-CtgExceptionText {
    param($Exception)
    $parts = [System.Collections.Generic.List[string]]::new()
    $e = $Exception
    while ($e) { $parts.Add([string]$e.Message); $e = $e.InnerException }
    $parts -join ' | '
}

# SharePoint throttling: 429 Too Many Requests, or 503 Server Too Busy / Service Unavailable.
function Test-CtgSharePointThrottled {
    param($Exception)
    (Get-CtgExceptionText $Exception) -match '\(429\)|\(503\)|\b429\b|\b503\b|Too Many Requests|throttl|Server Too Busy|Service Unavailable'
}

# The one answer that means "this person was never on this site": the user isn't in its user list.
function Test-CtgSharePointUserNotFound {
    param($Exception)
    (Get-CtgExceptionText $Exception) -match 'User cannot be found|user .*does not exist|could not be found|\(404\)|404 NOT FOUND'
}

# Run one site's work, retrying it while SharePoint throttles. The work must be idempotent (it re-reads
# the site's groups each time, so a half-done attempt is simply finished by the next one).
function Invoke-CtgSharePointSiteWithRetry {
    param([Parameter(Mandatory)][string]$Site, [Parameter(Mandatory)][scriptblock]$Work)
    for ($attempt = 0; ; $attempt++) {
        try { & $Work; return }
        catch {
            if ($attempt -lt $script:CtgSpRetryDelays.Count -and (Test-CtgSharePointThrottled $_.Exception)) {
                $d = [int]$script:CtgSpRetryDelays[$attempt]
                Write-CtgSharePointStep "SharePoint is throttling ($site) — retrying in ${d}s ($($attempt + 1)/$($script:CtgSpRetryDelays.Count))"
                Start-Sleep -Seconds $d
                continue
            }
            throw
        }
    }
}

# Progress for a site walk: first site, every Nth, and whenever it's been a while — never silent long
# enough for the stall watchdog, never one post per site on a 5,000-site tenant.
function New-CtgSiteWalkProgress {
    param([Parameter(Mandatory)][string]$Verb, [Parameter(Mandatory)][int]$Total)
    @{ Verb = $Verb; Total = $Total; Clock = [System.Diagnostics.Stopwatch]::StartNew(); Last = -1.0 }
}
function Step-CtgSiteWalkProgress {
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][int]$Index, [string]$Site)
    $now = $State.Clock.Elapsed.TotalSeconds
    if ($Index -eq 1 -or ($Index % $script:CtgSpProgressEverySites) -eq 0 -or ($now - $State.Last) -ge $script:CtgSpProgressEverySeconds) {
        $State.Last = $now
        Write-CtgSharePointStep "$($State.Verb): site $Index of $($State.Total) ($Site)"
    }
}

# The tenant's SharePoint sites worth checking: every site collection except personal OneDrives (the
# OneDrive hand-off handles those) and system sites. Cached per tenant.
function Get-CtgSharePointSiteUrls {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][string]$AdminUrl,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{},
        [switch]$NoCache
    )
    $hit = $script:CtgSiteCache[$Tenant]
    if (-not $NoCache -and $hit -and ((Get-Date) - $hit.At).TotalHours -lt $script:CtgSiteCacheHours) { return @($hit.Urls) }
    Connect-CtgSharePointPnP -Url $AdminUrl -AppId $AppId -Tenant $Tenant @CertArgs
    $urls = @(Get-PnPTenantSite -ErrorAction Stop |
        Where-Object { $_.Url -and $_.Url -notmatch '-my\.sharepoint\.com' -and ([string]$_.Template) -notmatch '^(SRCHCEN|SPSMSITEHOST|APPCATALOG|POINTPUBLISHINGHUB|EDISC|TEAMCHANNEL)' } |
        ForEach-Object { [string]$_.Url } | Sort-Object -Unique)
    $script:CtgSiteCache[$Tenant] = @{ At = Get-Date; Urls = $urls }
    return $urls
}

# The site groups $Email is in on the CURRENTLY connected site, as group titles. Empty ONLY when the
# person has never been on the site (not in its user information list) — the cheap early exit. Any
# other failure throws: an error is not an answer.
function Get-CtgSiteGroupsForUser {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string]$Email)
    $login = ConvertTo-CtgClaimsLogin $Email
    $u = $null
    try { $u = Get-PnPUser -Identity $login -ErrorAction Stop }
    catch {
        if (Test-CtgSharePointUserNotFound $_.Exception) { return @() }
        throw
    }
    if (-not $u) { return @() }
    $in = foreach ($g in @(Get-PnPGroup -ErrorAction Stop)) {
        $members = @(Get-PnPGroupMember -Group $g -ErrorAction Stop)
        if ($members | Where-Object { ([string](Get-CtgProp $_ 'LoginName')) -ieq $login -or ([string](Get-CtgProp $_ 'Email')) -ieq $Email }) { [string]$g.Title }
    }
    return @($in)
}

# The closing message when some sites couldn't be finished: what failed and why, then what WAS done.
function Format-CtgSiteFailures {
    param([string]$Lead, [System.Collections.Generic.List[string]]$Failed, [int]$Total, [string[]]$Done)
    $shown = @($Failed | Select-Object -First 10)
    $more = if ($Failed.Count -gt $shown.Count) { " … and $($Failed.Count - $shown.Count) more" } else { '' }
    "$Lead on $($Failed.Count) of $Total site(s): $($shown -join '; ')$more. Re-run the step once the cause is fixed (it only changes what is still left to do). Done on the other sites: $(($Done | Where-Object { $_ }) -join '; ')"
}

# Offboard: remove $Email from every site group, on every site in $Sites. A failing site doesn't stop
# the walk — one locked or throttled site must not cost the removals on the rest — but it does FAIL the
# step at the end, naming the sites the leaver may still have access to.
function Invoke-CtgSharePointSiteGroupsOffboard {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$Email,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Sites,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $failed = [System.Collections.Generic.List[string]]::new()
    $login = ConvertTo-CtgClaimsLogin $Email
    $n = @{ Removed = 0; SitesWith = 0 }
    $cert = New-CtgPnPCertFile $CertArgs
    $certArgs = $cert.CertArgs   # splatted per site below
    try {
        $progress = New-CtgSiteWalkProgress -Verb "removing $Email from SharePoint site groups" -Total $Sites.Count
        $i = 0
        foreach ($site in $Sites) {
            $i++
            Step-CtgSiteWalkProgress -State $progress -Index $i -Site $site
            try {
                Invoke-CtgSharePointSiteWithRetry -Site $site -Work {
                    Connect-CtgSharePointPnP -Url $site -AppId $AppId -Tenant $Tenant @certArgs
                    $groups = @(Get-CtgSiteGroupsForUser -Email $Email)
                    if ($groups.Count -eq 0) { return }
                    $n.SitesWith++
                    foreach ($g in $groups) {
                        if ($PSCmdlet.ShouldProcess("$site / $g", "remove $Email")) {
                            Remove-PnPGroupMember -Group $g -LoginName $login -ErrorAction Stop
                            $actions.Add("removed from site group '$g' on $site"); $n.Removed++
                        }
                        else { $actions.Add("would remove from site group '$g' on $site (dry run)") }
                    }
                }
            }
            catch { $failed.Add("$site ($($_.Exception.Message))") }
        }
    }
    finally { Remove-CtgPnPCertFile $cert.Path }
    $summary = "SharePoint site groups: removed $Email from $($n.Removed) group(s) on $($n.SitesWith) of $($Sites.Count) site(s)"
    if ($failed.Count) {
        throw (Format-CtgSiteFailures -Lead "SharePoint site groups: couldn't check or clean up $Email, who may still have access there," -Failed $failed -Total $Sites.Count -Done (@($actions) + $summary))
    }
    $actions.Add($summary)
    return $actions.ToArray()
}

# Onboard mirror: add $NewEmail to each site group $ReferenceEmail is in, on every site in $Sites.
# $Exclude takes the mirror policy's exclude wildcards (FR #119), matched against the group title.
# Failing sites are handled as on offboard: the walk finishes, then the step fails naming them.
function Invoke-CtgSharePointSiteGroupsMirror {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$NewEmail,
        [Parameter(Mandatory)][string]$ReferenceEmail,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Sites,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{},
        [string[]]$Exclude = @()
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $failed = [System.Collections.Generic.List[string]]::new()
    $newLogin = ConvertTo-CtgClaimsLogin $NewEmail
    $n = @{ Added = 0; Held = 0 }
    $cert = New-CtgPnPCertFile $CertArgs
    $certArgs = $cert.CertArgs   # splatted per site below
    try {
        $progress = New-CtgSiteWalkProgress -Verb "mirroring $ReferenceEmail's SharePoint site groups" -Total $Sites.Count
        $i = 0
        foreach ($site in $Sites) {
            $i++
            Step-CtgSiteWalkProgress -State $progress -Index $i -Site $site
            try {
                Invoke-CtgSharePointSiteWithRetry -Site $site -Work {
                    Connect-CtgSharePointPnP -Url $site -AppId $AppId -Tenant $Tenant @certArgs
                    $refGroups = @(Get-CtgSiteGroupsForUser -Email $ReferenceEmail)
                    if ($refGroups.Count -eq 0) { return }
                    $already = @(Get-CtgSiteGroupsForUser -Email $NewEmail)
                    foreach ($g in $refGroups) {
                        if (@($Exclude | Where-Object { $_ -and $g -like $_ }).Count) { $n.Held++; $actions.Add("not mirrored: site group '$g' on $site — excluded by the client's mirror policy"); continue }
                        if ($already -contains $g) { $actions.Add("already in site group '$g' on $site"); continue }
                        if ($PSCmdlet.ShouldProcess("$site / $g", "add $NewEmail")) {
                            Add-PnPGroupMember -Group $g -LoginName $newLogin -ErrorAction Stop
                            $actions.Add("added to site group '$g' on $site (mirrored from $ReferenceEmail)"); $n.Added++
                        }
                        else { $actions.Add("would add to site group '$g' on $site (dry run)") }
                    }
                }
            }
            catch { $failed.Add("$site ($($_.Exception.Message))") }
        }
    }
    finally { Remove-CtgPnPCertFile $cert.Path }
    $summary = "SharePoint site groups: mirrored $($n.Added) group(s) from $ReferenceEmail$(if ($n.Held) { ", $($n.Held) held back by the mirror policy" })"
    if ($failed.Count) {
        throw (Format-CtgSiteFailures -Lead "SharePoint site groups: couldn't mirror $ReferenceEmail's site groups onto $NewEmail" -Failed $failed -Total $Sites.Count -Done (@($actions) + $summary))
    }
    $actions.Add($summary)
    return $actions.ToArray()
}

# The reference user for an onboard mirror, as a UPN. An email/UPN is matched exactly (sign-in name or
# mailbox address). A display name must match exactly ONE person — two people with the name is a
# question for the operator, never a pick (the first cut took -Top 1 and mirrored whoever came back).
# Tries the same name variants as Resolve-CtgEntraUser ("James (Jim) Goodmiller" → "James Goodmiller",
# "Jim Goodmiller"). Returns $null when nobody matches; throws on an ambiguous name.
function Resolve-CtgSharePointMirrorUser {
    param([Parameter(Mandatory)][string]$Identity)
    $id = $Identity.Trim()
    if (-not $id) { return $null }
    $esc = { param($s) ($s -replace "'", "''") }
    if ($id -match '@') {
        $e = & $esc $id
        $hits = @(Get-MgUser -Filter "userPrincipalName eq '$e' or mail eq '$e'" -Top 2 -ErrorAction Stop)
        if ($hits.Count -gt 1) { throw "the mirror user '$id' matches $($hits.Count) accounts (one's sign-in name is another's mailbox address) — give the reference user's exact sign-in name on the case." }
        if ($hits.Count -eq 1) { return [string]$hits[0].UserPrincipalName }
    }
    $variants = [System.Collections.Generic.List[string]]::new()
    $variants.Add($id)
    if ($id -match '\(([^)]+)\)') {
        $nick = $Matches[1].Trim()
        $stripped = ((($id -replace '\s*\([^)]*\)\s*', ' ').Trim()) -replace '\s+', ' ')
        $variants.Add($stripped)
        $rest = ($stripped -replace '^\S+\s*', '').Trim()
        if ($nick -and $rest) { $variants.Add("$nick $rest") }
    }
    foreach ($v in @($variants | Where-Object { $_ -and $_ -notmatch '@' } | Select-Object -Unique)) {
        $hits = @(Get-MgUser -Filter "displayName eq '$(& $esc $v)'" -Top 2 -ErrorAction Stop)
        if ($hits.Count -gt 1) { throw "2 or more people in Entra are named '$v', so the mirror user is ambiguous — SharePoint site groups were not mirrored rather than copy the wrong person's. Give the reference user's email on the case and re-run." }
        if ($hits.Count -eq 1) { return [string]$hits[0].UserPrincipalName }
    }
    return $null
}

# The account the new hire actually got. The m365/entra step may have created them at a FALLBACK
# username (the primary belonged to someone else). The app decides WHICH rule applies
# (sharepointAccountDecision in web/lib/jobs/provisioned-upn.ts) and hands it on as payload.accountRule:
#   reported           payload.provisionedUpn, the account a succeeded m365/entra api step reported.
#   wait               an api m365/entra step can still report it (unfinished, or failed without an
#                      acceptance for its latest run, e.g. waiting on a username-collision decision
#                      while jsmith@ belongs to an existing John Smith). Refuse and say we're waiting.
#                      An absent rule (an app from before this hand-off) waits too.
#   operator-required  an api step did NOT report it (failure accepted, done by hand, skipped, no Upn).
#                      It may have failed BECAUSE the primary is someone else's, so the primary is never
#                      used: only payload.confirmedUpn, a Username an operator set on the case after that
#                      step last ran. Otherwise refuse, naming the field and why.
#   planned-manual     the step is manual/scim by plan: confirmedUpn (operator-set) if present, else
#                      the sole candidate.
#   no-cloud-step      the sole candidate.
function Resolve-CtgSharePointNewHireUpn {
    param($Payload)
    $rule = [string](Get-CtgProp $Payload 'accountRule')
    $provisioned = [string](Get-CtgProp $Payload 'provisionedUpn')
    $confirmed = [string](Get-CtgProp $Payload 'confirmedUpn')
    if ($provisioned) { return $provisioned }
    if (-not $rule -or $rule -eq 'wait' -or $rule -eq 'reported') {
        throw "waiting for the Microsoft 365 step to create the new hire's account — it hasn't finished yet (it may be waiting on a decision), and the username on the case could still belong to someone else. SharePoint site groups were not mirrored; re-run this step once the Microsoft 365 step has succeeded."
    }
    if ($rule -eq 'operator-required') {
        if ($confirmed) { return $confirmed }
        $why = [string](Get-CtgProp $Payload 'accountReason'); if (-not $why) { $why = "the Microsoft 365 step didn't report the account it created" }
        throw "can't tell which account the new hire was created with: $why, and it may have failed because the username on the case ($([string](Get-CtgProp $Payload 'UserPrincipalName'))) belongs to someone else. Set Username (userPrincipalName) on the case to the account the new hire actually has — after the Microsoft 365 step last ran, so an earlier value isn't trusted — then re-run this step."
    }
    if ($rule -eq 'planned-manual' -and $confirmed) { return $confirmed }
    if ($rule -notin @('planned-manual', 'no-cloud-step')) { throw "unknown account rule '$rule' for the SharePoint mirror — SharePoint site groups were not mirrored." }
    $upn = [string](Get-CtgProp $Payload 'UserPrincipalName')
    if (-not $upn) {
        $alt = @(@('email', 'workEmail') | ForEach-Object { [string](Get-CtgProp $Payload $_) } | Where-Object { $_ } | Select-Object -First 1)
        $upn = if ($alt.Count) { $alt[0] } else { '' }
    }
    $fallbacks = @(@(Get-CtgProp $Payload 'UserPrincipalNameFallbacks') | Where-Object { $_ -and ([string]$_) -ine $upn })
    if ($upn -and $fallbacks.Count) {
        throw "can't tell which account the new hire was created with: no automated Microsoft 365 step reports it on this case, and the username could be $upn or $($fallbacks -join ', '). Set Username (userPrincipalName) on the case to the account that was actually created, then re-run this step."
    }
    return $upn
}

# The whole SharePoint site-groups step, for one job. The expensive, fallible setup — PnP, the
# certificate, the tenant's admin URL, the site list — is behind -Context, a scriptblock returning
# @{ AppId; Tenant; CertArgs; AdminUrl }, and is only run once there is actually work to do: an onboard
# with no mirror user is a clean no-op that never touches PnP (it used to fail for nothing when PnP or
# the cert wasn't there). Offboard takes the leaver's UPN from the caller (-LeaverUpn), which resolves it
# the same way the m365 lane does.
function Invoke-CtgSharePointSiteGroupsStep {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Lane,
        $Payload,
        $Config,
        [string]$LeaverUpn,
        [Parameter(Mandatory)][scriptblock]$Context,
        [switch]$InProcess
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $result = { param($email) [pscustomobject]@{ System = 'sharepoint'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() } }
    if ($Lane -eq 'offboard') {
        if (-not $LeaverUpn) { throw "the case carries no email/UPN for the user — set it on the case and re-run." }
        $email = $LeaverUpn
    }
    else {
        $mirror = [string](Get-CtgProp $Config 'mirrorFromUser')
        if (-not $mirror.Trim()) { $actions.Add("no mirror user on this onboard — no SharePoint site groups to copy"); return (& $result $null) }
        $email = Resolve-CtgSharePointNewHireUpn $Payload
        if (-not $email) { throw "the case carries no email/UPN for the new hire — set it on the case and re-run." }
        $refUpn = Resolve-CtgSharePointMirrorUser -Identity $mirror
        if (-not $refUpn) { $actions.Add("WARN mirror user not found in Entra: $mirror — SharePoint site groups not mirrored"); return (& $result $email) }
        $exclude = @(@(Get-CtgProp (Get-CtgProp $Config 'mirrorPolicy') 'exclude') | Where-Object { $_ } | ForEach-Object { [string]$_ })
    }
    # Everything above is Graph and stays in this process. Everything below is PnP, and PnP must never
    # load in the runner (see Invoke-CtgPnPGrantOutOfProcess: its identity assemblies clash with Graph's
    # and Graph stops answering). The walk runs in a child pwsh; -InProcess is for the tests, which
    # exercise the walk itself with PnP mocked.
    $ctx = & $Context
    $walk = @{
        Lane = $Lane; Email = $email; AppId = $ctx.AppId; Tenant = $ctx.Tenant; CertArgs = $ctx.CertArgs; AdminUrl = $ctx.AdminUrl
        # Offboard ALWAYS lists fresh (and refreshes the cache): a site created inside the 6 h cache
        # window would otherwise never be walked, and the leaver would keep access there while the
        # step reported success. A mirror that misses a brand-new site only grants less, so it may use the cache.
        NoCache = ($Lane -eq 'offboard')
    }
    if ($Lane -eq 'onboard') { $walk.ReferenceEmail = $refUpn; $walk.Exclude = $exclude }
    $walked = if ($InProcess) { Invoke-CtgSharePointSiteGroupsWalk @walk } else { Invoke-CtgSharePointSiteWalkOutOfProcess -Walk $walk }
    foreach ($a in @($walked)) { $actions.Add([string]$a) }
    return (& $result $email)
}

# The PnP half of the site-groups step: list the tenant's sites (unless -Sites is given), then remove
# the leaver from, or mirror the reference user's, site groups on each. Runs in the child pwsh that
# Invoke-CtgSharePointSiteWalkOutOfProcess starts (or in-process under the tests). -OnSites is told the
# freshly listed sites, so the parent can keep the per-tenant cache the child's short life can't.
function Invoke-CtgSharePointSiteGroupsWalk {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Lane,
        [Parameter(Mandatory)][string]$Email,
        [string]$ReferenceEmail,
        [string[]]$Exclude = @(),
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{},
        [string]$AdminUrl,
        [AllowEmptyCollection()][string[]]$Sites,
        [switch]$NoCache,
        [scriptblock]$OnSites
    )
    $cert = New-CtgPnPCertFile $CertArgs   # once for the site listing AND the whole walk
    try {
        if ($null -eq $Sites) {
            Write-CtgSharePointStep "listing SharePoint sites$(if ($NoCache) { ' (fresh)' } else { ' (cached per tenant)' })"
            $Sites = @(Get-CtgSharePointSiteUrls -AdminUrl $AdminUrl -AppId $AppId -Tenant $Tenant -CertArgs $cert.CertArgs -NoCache:$NoCache)
            if ($OnSites) { & $OnSites $Sites }
        }
        if ($Lane -eq 'offboard') {
            Write-CtgSharePointStep "removing $Email from site groups on $($Sites.Count) site(s)"
            return @(Invoke-CtgSharePointSiteGroupsOffboard -Email $Email -Sites $Sites -AppId $AppId -Tenant $Tenant -CertArgs $cert.CertArgs)
        }
        Write-CtgSharePointStep "mirroring $ReferenceEmail's site groups onto $Email across $($Sites.Count) site(s)"
        return @(Invoke-CtgSharePointSiteGroupsMirror -NewEmail $Email -ReferenceEmail $ReferenceEmail -Sites $Sites -AppId $AppId -Tenant $Tenant -CertArgs $cert.CertArgs -Exclude $Exclude)
    }
    finally { Remove-CtgPnPCertFile $cert.Path }
}

# Longest the site-walk child may go without printing a line before it is presumed hung and stopped.
# The walk narrates at least every 30 s and its longest throttle back-off is 60 s, so a live child is
# never this quiet. It stays well under the runner's 600 s stall watchdog, so a hung child is stopped
# and reported as a failed step instead of taking the whole runner down with it.
$script:CtgSpWalkQuietSeconds = 420

# Run Invoke-CtgSharePointSiteGroupsWalk in a clean child pwsh, relaying its progress live.
# The child prints one tagged line per event: PROGRESS / ACT / SITES (base64 text), then DONE, or FAIL
# with the walk's own failure message. The request, certificate included, goes in a file in a private
# per-call directory, which the child deletes before it does anything else and this function removes in
# a finally; it is never on a command line. Returns the walk's action lines; throws its failure
# message, or a plain account of a child that crashed, hung or ended without a verdict.
function Invoke-CtgSharePointSiteWalkOutOfProcess {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][hashtable]$Walk,
        [string]$ModulePath = (Join-Path $PSScriptRoot 'Coretelligent.SharePoint.psd1'),
        [int]$QuietSeconds = $script:CtgSpWalkQuietSeconds
    )
    $w = $Walk.Clone()
    $hit = $script:CtgSiteCache[[string]$w.Tenant]
    if (-not $w.NoCache -and $hit -and ((Get-Date) - $hit.At).TotalHours -lt $script:CtgSiteCacheHours) { $w.Sites = @($hit.Urls) }

    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath -or (Split-Path $pwshPath -Leaf) -notmatch '^pwsh') { $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
    if (-not $pwshPath) { throw 'cannot locate pwsh to run the SharePoint site walk in a clean process' }

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-spwalk-" + [guid]::NewGuid().ToString('N'))
    # .NET file calls, not the cmdlets, all through here: a dry run sets $WhatIfPreference, and New-Item /
    # Set-Content / Remove-Item honour it, so the request never reached the child and the cleanup left the
    # certificate behind.
    $null = [System.IO.Directory]::CreateDirectory($dir)
    if (-not $IsWindows) { & chmod 700 $dir 2>$null }
    $payloadPath = Join-Path $dir 'walk.json'
    $childPath = Join-Path $dir 'walk.ps1'
    $p = $null
    try {
        [System.IO.File]::WriteAllText($payloadPath, (@{ Walk = $w; ModulePath = $ModulePath; WhatIf = [bool]$WhatIfPreference } | ConvertTo-Json -Depth 6 -Compress))
        if (-not $IsWindows) { & chmod 600 $payloadPath 2>$null }
        [System.IO.File]::WriteAllText($childPath, @'
param([string]$PayloadPath)
$ErrorActionPreference = 'Stop'
function global:Send-CtgLine { param([string]$Tag, [string]$Text) [Console]::Out.WriteLine($Tag + "`t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))) }
function global:Send-CtgProgress { param([string]$Message) Send-CtgLine 'PROGRESS' $Message }
try {
    $p = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json -AsHashtable
    Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
    Import-Module $p.ModulePath -Force
    $walk = $p.Walk
    if (-not $walk.CertArgs) { $walk.CertArgs = @{} }
    $walk.OnSites = { param($s) Send-CtgLine 'SITES' (ConvertTo-Json -InputObject @($s) -Compress) }
    $acts = Invoke-CtgSharePointSiteGroupsWalk @walk -WhatIf:([bool]$p.WhatIf)
    foreach ($a in @($acts)) { Send-CtgLine 'ACT' ([string]$a) }
    [Console]::Out.WriteLine('DONE')
}
catch { Send-CtgLine 'FAIL' $_.Exception.Message; exit 3 }
'@)
        $psi = [System.Diagnostics.ProcessStartInfo]::new($pwshPath)
        foreach ($a in @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $childPath, '-PayloadPath', $payloadPath)) { $psi.ArgumentList.Add($a) }
        $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $errTask = $p.StandardError.ReadToEndAsync()
        $dec = { param($b) try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) } catch { $b } }
        $acts = [System.Collections.Generic.List[string]]::new()
        $fail = $null; $done = $false
        $quiet = [System.Diagnostics.Stopwatch]::StartNew()
        $read = $p.StandardOutput.ReadLineAsync()
        while ($true) {
            if (-not $read.Wait(1000)) {
                if ($quiet.Elapsed.TotalSeconds -lt $QuietSeconds) { continue }
                try { $p.Kill($true) } catch { }
                throw "SharePoint site groups: the SharePoint helper went $QuietSeconds s without reporting anything and was stopped, so the walk did not finish$(if ($acts.Count) { ". Done before it stopped: $($acts -join '; ')" }). Re-run the step (it only changes what is still left to do)."
            }
            $line = $read.Result
            if ($null -eq $line) { break }
            $quiet.Restart()
            $tag, $body = $line -split "`t", 2
            switch ($tag) {
                'PROGRESS' { Write-CtgSharePointStep (& $dec $body) }
                'ACT' { $acts.Add((& $dec $body)) }
                'SITES' { $script:CtgSiteCache[[string]$w.Tenant] = @{ At = Get-Date; Urls = @((& $dec $body) | ConvertFrom-Json) } }
                'FAIL' { $fail = & $dec $body }
                'DONE' { $done = $true }
            }
            $read = $p.StandardOutput.ReadLineAsync()
        }
        $p.WaitForExit()
        if ($fail) { throw $fail }
        if (-not $done) {
            $first = @(([string]$errTask.Result -split "`r?`n") | Where-Object { $_.Trim() }) | Select-Object -First 1
            $why = if ($p.ExitCode -in @(-1073741571, 134) -or "$first" -match 'Stack overflow') { 'crashed (stack overflow in PnP.PowerShell)' } else { "exited with code $($p.ExitCode)$(if ($first) { ": $first" })" }
            throw "SharePoint site groups: the SharePoint helper $why before finishing, so the walk is incomplete$(if ($acts.Count) { ". Done before it stopped: $($acts -join '; ')" }). The runner kept running; re-run the step."
        }
        return $acts.ToArray()
    }
    finally {
        if ($p) { $p.Dispose() }
        try { [System.IO.Directory]::Delete($dir, $true) } catch { }
    }
}

# Run the PnP grants in a CLEAN CHILD pwsh, so PnP.PowerShell's assemblies never enter the runner
# process. This is not tidiness — it is the fix for a production incident (2026-09-23..25).
#
# PnP.PowerShell ships its own Microsoft.Identity.Client, Microsoft.IdentityModel.* and
# System.IdentityModel.Tokens.Jwt. Microsoft.Graph is already loaded in the runner and carries its own
# copies. Start-IamRunner.ps1's own $script:CtgAssemblySharingGroups comment states what happens when a
# second module binds those: "the second import binds an incompatible copy and the FIRST module's calls
# stop returning" — i.e. Graph goes silent, every later m365 job wedges, and the stall watchdog restarts
# the runner 600s later. That surfaced as the runner "crashing" with nothing in runner.log, because a
# hang writes no error.
#
# Importing this module is harmless (the .psd1 declares no RequiredModules). It is CALLING a PnP cmdlet
# that auto-loads the assemblies, so the whole of that call has to happen somewhere else. The Graph-side
# work — resolving the leaver, the drive, the site URL, the delegates and their ambiguity — deliberately
# stays in the parent, where Graph already works; only the PnP grants cross the boundary. Sending the
# Graph work too would just move the same clash into the child.
#
# The certificate reaches the child through a file in a private per-invocation directory, deleted by the
# child before it does anything else, never on the command line where any process list would show it.
# Same reasoning as Invoke-CtgAdSyncRemote's DPAPI hand-off in Coretelligent.DirectorySync.
# Turn the child's stdout into action lines. Its own function because this is where a failed grant
# either gets reported or disappears, and this repo has lost that argument before — a browser install
# that "gave no output" (#80/#81), a sync wait that reported "probably fine" (FR #127). A child that
# said nothing recognisable is reported as such, never as success.
function ConvertFrom-CtgPnPGrantOutput {
    [CmdletBinding()]
    param([AllowEmptyCollection()][string[]]$Lines = @(), [int]$ExitCode = 0)
    $clean = @($Lines | Where-Object { $_ -and $_.Trim() })
    $actions = [System.Collections.Generic.List[string]]::new()
    foreach ($l in $clean) {
        if ($l -like "OK`t*") { $actions.Add($l.Substring(3)) }
        elseif ($l -like "ERR`t*") {
            $parts = $l.Substring(4) -split "`t", 2
            $label = $parts[0]
            $why = if ($parts.Count -gt 1) { $parts[1] } else { 'no reason given' }
            $actions.Add("WARN could not grant ${label}: $why")
        }
    }
    if ($actions.Count -eq 0) {
        $tail = ($clean | Select-Object -Last 4) -join ' | '
        $actions.Add("WARN the SharePoint grant helper exited ($ExitCode) without reporting any grant" + $(if ($tail) { ": $tail" } else { ' and produced no output' }))
    }
    $actions.ToArray()
}

function Invoke-CtgPnPGrantOutOfProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Grants,   # @( @{ SiteUrl; Delegate; Label } )
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [hashtable]$CertArgs = @{},
        [int]$TimeoutSeconds = 600
    )
    if (-not $Grants -or @($Grants).Count -eq 0) { return @() }
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
    if (-not $pwshPath) { throw 'cannot locate pwsh to run the SharePoint grants in a clean process' }

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-pnp-" + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $dir -Force
    if (-not $IsWindows) { & chmod 700 $dir 2>$null }
    $payloadPath = Join-Path $dir 'grants.json'
    $modulePath = Join-Path $PSScriptRoot 'Coretelligent.SharePoint.psd1'
    try {
        @{ Grants = @($Grants); AppId = $AppId; Tenant = $Tenant; CertArgs = $CertArgs; ModulePath = $modulePath } |
            ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $payloadPath -Encoding utf8
        if (-not $IsWindows) { & chmod 600 $payloadPath 2>$null }

        # The child reads the payload, DELETES it, then grants. Each line it prints is one action line;
        # a failure on one grant is reported and the rest still run, exactly as the in-process loop did.
        $child = @'
param([string]$PayloadPath)
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
Import-Module $p.ModulePath -Force
$certArgs = @{}
if ($p.CertArgs) { foreach ($k in $p.CertArgs.PSObject.Properties.Name) { $certArgs[$k] = $p.CertArgs.$k } }
foreach ($g in @($p.Grants)) {
    try { "OK`t" + (Grant-CtgSharePointSiteAccess -SiteUrl $g.SiteUrl -Delegate $g.Delegate -AppId $p.AppId -Tenant $p.Tenant @certArgs) }
    catch { "ERR`t" + $g.Label + "`t" + $_.Exception.Message }
}
'@
        $childPath = Join-Path $dir 'grant.ps1'
        Set-Content -LiteralPath $childPath -Value $child -Encoding utf8
        $out = & $pwshPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $childPath -PayloadPath $payloadPath 2>&1
        $code = $LASTEXITCODE
        return ConvertFrom-CtgPnPGrantOutput -Lines @($out | ForEach-Object { [string]$_ }) -ExitCode $code
    }
    finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# A OneDrive drive's webUrl points at the document library (…/personal/<user>/Documents[/…]), not the
# site itself — Grant-CtgSharePointSiteAccess needs the SITE root to add a site-collection admin. Strip
# everything from "/Documents" onward, keeping "https://TENANT-my.sharepoint.com/personal/<user>".
# Returns $null when the URL doesn't look like a OneDrive personal-site URL (caller then skips the grant
# rather than handing PnP a document-library path it can't resolve to a site).
function Get-CtgOneDriveSiteUrl {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$WebUrl)
    if ([string]::IsNullOrWhiteSpace($WebUrl)) { return $null }
    $m = [regex]::Match($WebUrl, '^(https?://[^/]+/personal/[^/]+)')
    if (-not $m.Success) { return $null }
    $m.Groups[1].Value
}

Export-ModuleMember -Function Connect-CtgSharePointPnP, Get-CtgSharePointSiteUrls, Invoke-CtgSharePointSiteGroupsOffboard, Invoke-CtgSharePointSiteGroupsMirror, Invoke-CtgSharePointSiteGroupsStep, Invoke-CtgSharePointSiteGroupsWalk, Invoke-CtgSharePointSiteWalkOutOfProcess, Grant-CtgSharePointSiteAccess, Get-CtgOneDriveSiteUrl, Test-CtgOffboardResolved, Invoke-CtgSharePointOffboardGrant, Test-CtgDelegateUnambiguous, Invoke-CtgPnPGrantOutOfProcess, ConvertFrom-CtgPnPGrantOutput
