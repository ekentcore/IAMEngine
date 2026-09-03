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
        [string]$CertificateThumbprint
    )
    if ($CertificateBase64) {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-pnp-" + [guid]::NewGuid().ToString('N') + ".pfx")
        try {
            [System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(($CertificateBase64 -replace '\s', '')))
            $sec = if ($CertificatePassword) { ConvertTo-SecureString ([string]$CertificatePassword) -AsPlainText -Force } else { $null }
            $a = @{ Url = $Url; ClientId = $AppId; Tenant = $Tenant; CertificatePath = $tmp }
            if ($sec) { $a['CertificatePassword'] = $sec }
            Connect-PnPOnline @a
        }
        finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
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
        [hashtable]$CertArgs = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
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

        if ($odSiteUrl) {
            try { $actions.Add((Grant-CtgSharePointSiteAccess -SiteUrl $odSiteUrl -Delegate $delegateEmail -AppId $AppId -Tenant $Tenant @CertArgs)) }
            catch {
                $emsg = try { $ge = Get-CtgGraphError $_; "$($ge.Code) $($ge.Message)".Trim() } catch { $_.Exception.Message }
                $actions.Add("WARN could not grant $delegateEmail SharePoint access to the leaver's OneDrive site: $emsg")
            }
        }

        # Any additional profile-configured SharePoint sites (string[] of site URLs) — same resolved
        # delegate, one grant per site.
        foreach ($site in $extraSites) {
            try { $actions.Add((Grant-CtgSharePointSiteAccess -SiteUrl $site -Delegate $delegateEmail -AppId $AppId -Tenant $Tenant @CertArgs)) }
            catch {
                $emsg = try { $ge = Get-CtgGraphError $_; "$($ge.Code) $($ge.Message)".Trim() } catch { $_.Exception.Message }
                $actions.Add("WARN could not grant $delegateEmail access to SharePoint site '$site': $emsg")
            }
        }
    }
    $actions.ToArray()
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

Export-ModuleMember -Function Connect-CtgSharePointPnP, Grant-CtgSharePointSiteAccess, Get-CtgOneDriveSiteUrl, Test-CtgOffboardResolved, Invoke-CtgSharePointOffboardGrant, Test-CtgDelegateUnambiguous
