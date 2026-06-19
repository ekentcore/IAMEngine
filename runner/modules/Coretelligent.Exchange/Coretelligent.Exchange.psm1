#Requires -Version 7.0

# Coretelligent.Exchange
# Exchange Online offboard via the EXO V3 module (ExchangeOnlineManagement). Converts the
# mailbox to shared (honoring the >50 GB skip — keep it a licensed user mailbox), disables
# mobile/ActiveSync/OWA, and applies on-request OOO / forwarding. Runs BEFORE the m365 license
# removal (the "don't remove the license until the mailbox is handled" ordering rule).
# Idempotent: re-running re-applies the same desired state.
#
# Auth: EXO app-only requires CERTIFICATE auth (Connect-ExchangeOnline -AppId -Organization
# -CertificateThumbprint), not a client secret — provision a cert for the `m365-admin` app.

Set-StrictMode -Version Latest

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Narrate a step into the live run-report progress. Send-CtgProgress is the runner's global poster;
# it's absent under Pester, so guard it — narration must never affect the executor's behavior.
function Write-CtgStep([string]$Message) {
    if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress $Message }
}

# Exchange Online (cloud) session — app-only certificate auth. Used for the EXO-side cmdlets:
# offboard (convert-to-shared, CAS), the post-sync mailbox wait, and regional/calendar finishing.
function Connect-CtgExchange {
    # App-only Exchange Online. Two auth paths:
    #   - CertificateBase64 (+ optional password): a PFX (private key) base64-encoded — cross-platform
    #     (macOS / Linux / Windows). Written to a temp .pfx and passed via -CertificateFilePath, then
    #     deleted. (An in-memory X509Certificate2 with EphemeralKeySet fails on macOS: "This platform
    #     does not support loading with EphemeralKeySet.") PREFERRED for a non-Windows central runner.
    #   - CertificateThumbprint: reads the WINDOWS certificate store — Windows-only.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Organization,
        [string]$CertificateThumbprint,
        [string]$CertificateBase64,
        [string]$CertificatePassword
    )
    if ($CertificateBase64) {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-exo-" + [guid]::NewGuid().ToString('N') + ".pfx")
        try {
            [System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(($CertificateBase64 -replace '\s', '')))
            $sec = if ($CertificatePassword) { ConvertTo-SecureString ([string]$CertificatePassword) -AsPlainText -Force } else { [System.Security.SecureString]::new() }
            Connect-ExchangeOnline -AppId $AppId -Organization $Organization -CertificateFilePath $tmp -CertificatePassword $sec -ShowBanner:$false
        }
        finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }  # never leave the private key on disk
    }
    elseif ($CertificateThumbprint) {
        # A thumbprint resolves the cert from the WINDOWS certificate store — which only exists on
        # Windows. On the central macOS/Linux runner there's nothing to look it up in, so fail fast
        # with the fix instead of a confusing store/parameter error.
        if (-not $IsWindows) {
            throw "a CertificateThumbprint only works on a WINDOWS runner (it reads the Windows certificate store). This runner is $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription) — store the cert as CertificateBase64 (the .pfx, base64-encoded) on the m365-admin secret instead; that's cross-platform. (A thumbprint is fine if you run this client on a Windows client-network agent that has the cert installed.)"
        }
        Connect-ExchangeOnline -AppId $AppId -Organization $Organization -CertificateThumbprint $CertificateThumbprint -ShowBanner:$false
    }
    else {
        throw "Connect-CtgExchange needs app-only cert auth: a CertificateBase64 (a .pfx, cross-platform) or a CertificateThumbprint (Windows cert store). The m365-admin secret has neither."
    }
    Write-Verbose "Connected to Exchange Online for $Organization."
}

# On-prem Exchange management session (hybrid only) — the *RemoteMailbox cmdlets (Enable/Get/Set-
# RemoteMailbox) live ON-PREM, not in EXO, so the hybrid enable step needs a remote PowerShell
# session to the client's Exchange server over Kerberos. We import ONLY *RemoteMailbox so the EXO
# cmdlets already in scope (Get-Mailbox, Set-MailboxRegionalConfiguration, …) are not clobbered.
# Returns the session so the caller can Remove-PSSession when the agent shuts down.
function Connect-CtgExchangeOnPrem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ConnectionUri,   # e.g. http://exch01.client.local/PowerShell/
        [Parameter(Mandatory)][pscredential]$Credential
    )
    $session = New-PSSession -ConfigurationName 'Microsoft.Exchange' -ConnectionUri $ConnectionUri -Authentication 'Kerberos' -Credential $Credential
    Import-PSSession -Session $session -CommandName '*RemoteMailbox' -AllowClobber -DisableNameChecking | Out-Null
    Write-Verbose "Connected to on-prem Exchange at $ConnectionUri (imported *RemoteMailbox)."
    $session
}

# Mailbox size in GB, parsed from Get-MailboxStatistics TotalItemSize ("75 GB (80,530,…bytes)").
function Get-CtgMailboxSizeGB {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Identity)
    $stats = Get-MailboxStatistics -Identity $Identity -ErrorAction SilentlyContinue
    if (-not $stats) { return 0 }
    $m = [regex]::Match([string]$stats.TotalItemSize, '([\d,]+)\s*bytes')
    if ($m.Success) { return [math]::Round([double]($m.Groups[1].Value -replace ',', '') / 1GB, 2) }
    return 0
}

# Hybrid onboarding: enable the on-prem remote mailbox so Azure AD Connect provisions a mailbox in
# Exchange Online. Runs on the client-network agent against the ON-PREM Exchange management session
# (Enable-RemoteMailbox / *-RemoteMailbox), not EXO. Idempotent: skips if already remote-enabled.
# Config.enableRemoteMailbox: { routingDomain, emailAddressPolicyEnabled }.
function Invoke-CtgExchangeOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $cfg = Get-CtgProp $Config 'enableRemoteMailbox'
    if (-not $cfg) { return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Actions = @('no remote-mailbox config — skipped') } }

    $identity = $User.SamAccountName
    $alias = ([string]((Get-CtgProp $User 'MailNickname') ?? $User.SamAccountName)).ToLower()
    $smtp = (Get-CtgProp $User 'WorkEmail') ?? (Get-CtgProp $User 'UserPrincipalName')
    $routingDomain = Get-CtgProp $cfg 'routingDomain'
    if ([string]::IsNullOrWhiteSpace($routingDomain)) {
        return [pscustomobject]@{ System = 'exchange'; Status = 'failed'; Error = 'enableRemoteMailbox.routingDomain is missing'; Actions = @('no routing domain — remote mailbox not enabled') }
    }
    $routing = "$alias@$routingDomain"

    $existing = Get-RemoteMailbox -Identity $identity -ErrorAction SilentlyContinue
    if ($existing) {
        Write-CtgStep "remote mailbox already enabled for $identity — skipping"
        $actions.Add("remote mailbox already enabled ($identity)")
    }
    elseif ($PSCmdlet.ShouldProcess($identity, "Enable remote mailbox -> $routing")) {
        Write-CtgStep "running: Enable-RemoteMailbox -Identity $identity -RemoteRoutingAddress $routing -PrimarySmtpAddress $smtp"
        Enable-RemoteMailbox -Identity $identity -RemoteRoutingAddress $routing -Alias $alias -DisplayName $User.DisplayName -PrimarySmtpAddress $smtp | Out-Null
        $actions.Add("enabled remote mailbox: $smtp (routing $routing)")
    }

    if ((Get-CtgProp $cfg 'emailAddressPolicyEnabled') -ne $false -and $PSCmdlet.ShouldProcess($identity, "EmailAddressPolicyEnabled = true")) {
        Write-CtgStep "running: Set-RemoteMailbox -Identity $identity -EmailAddressPolicyEnabled `$true"
        Set-RemoteMailbox -Identity $identity -EmailAddressPolicyEnabled $true
        $actions.Add("email address policy enabled")
    }
    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $smtp; Routing = $routing; Actions = $actions.ToArray() }
}

# Post-sync EXO finishing: regional config (language/timezone) + grant the manager Reviewer on the
# new user's calendar. Runs after the mailbox has landed in Exchange Online (see the sync-wait).
# A timezone that's still a literal {token} (the location had none) falls back to the default.
function Set-CtgMailboxRegional {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Identity, [Parameter(Mandatory)][pscustomobject]$Config, [string]$ManagerEmail)
    $actions = [System.Collections.Generic.List[string]]::new()

    $regional = Get-CtgProp $Config 'regional'
    if ($regional) {
        $lang = [string]((Get-CtgProp $regional 'language') ?? 'en-us')
        $tz = [string](Get-CtgProp $regional 'timezone')
        if ([string]::IsNullOrWhiteSpace($tz) -or $tz -match '\{') { $tz = [string]((Get-CtgProp $regional 'defaultTimezone') ?? 'Eastern Standard Time') }
        if ($PSCmdlet.ShouldProcess($Identity, "Regional: $lang / $tz")) {
            Write-CtgStep "running: Set-MailboxRegionalConfiguration -Identity $Identity -Language $lang -TimeZone `"$tz`""
            Set-MailboxRegionalConfiguration -Identity $Identity -Language $lang -TimeZone $tz
            $actions.Add("regional set: $lang / $tz")
        }
    }

    $cal = Get-CtgProp $Config 'calendar'
    if ($cal -and (Get-CtgProp $cal 'grantManagerReviewer') -and $ManagerEmail -and $PSCmdlet.ShouldProcess($Identity, "Grant $ManagerEmail Reviewer on calendar")) {
        Write-CtgStep "running: Add-MailboxFolderPermission -Identity ${Identity}:\Calendar -User $ManagerEmail -AccessRights Reviewer"
        Add-MailboxFolderPermission -Identity "${Identity}:\Calendar" -User $ManagerEmail -AccessRights Reviewer -Confirm:$false | Out-Null
        $actions.Add("granted $ManagerEmail Reviewer on calendar")
    }
    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Actions = $actions.ToArray() }
}

# Mirror the reference user's DISTRIBUTION lists and MAIL-ENABLED SECURITY groups — the groups the
# Graph (m365) lane can't modify. EXO-only: find the reference user's direct static memberships via
# Get-Recipient's Members filter, then Add-DistributionGroupMember the new user (by primary SMTP).
# Dynamic distribution groups are computed, not assignable, so they're not returned/handled. Runs in
# the exchange lane (which already has the EXO session) AFTER the mailbox lands, so the new user is a
# valid recipient. Idempotent; returns an actions array.
function Invoke-CtgExchangeDistListMirror {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$MirrorUser, [Parameter(Mandatory)][string]$NewUser)
    $actions = [System.Collections.Generic.List[string]]::new()
    $ref = Get-Recipient -Identity $MirrorUser -ErrorAction SilentlyContinue
    if (-not $ref) { $actions.Add("WARN mirror user not found in Exchange: $MirrorUser"); return $actions.ToArray() }

    Write-CtgStep "mirroring distribution / mail-enabled groups from $($ref.DisplayName)"
    # Skip DIR-SYNCED groups up front — those are AD-managed (the AD lane mirrors them via
    # Add-ADGroupMember and AAD Connect syncs the membership). EXO can't write them ("the object is
    # being synchronized from your on-premises organization"). Only cloud-only DLs/groups remain.
    $groups = @(Get-Recipient -ResultSize Unlimited -Filter "Members -eq '$($ref.DistinguishedName)'" -ErrorAction SilentlyContinue |
        Where-Object { $_.RecipientTypeDetails -in @('MailUniversalDistributionGroup', 'MailUniversalSecurityGroup', 'RoomList') -and -not $_.IsDirSynced })
    $copied = 0; $skipped = 0
    foreach ($g in $groups) {
        if (-not $PSCmdlet.ShouldProcess($NewUser, "Add to $($g.DisplayName)")) { continue }
        try {
            Add-DistributionGroupMember -Identity $g.Identity -Member $NewUser -BypassSecurityGroupManagerCheck -ErrorAction Stop
            $actions.Add("mirrored group: $($g.DisplayName)"); Write-CtgStep "✓ mirrored group: $($g.DisplayName)"; $copied++
        } catch {
            $m = $_.Exception.Message
            if ($m -match 'already a member') { $actions.Add("already in group: $($g.DisplayName)"); Write-CtgStep "– already a member: $($g.DisplayName)" }
            # Belt-and-suspenders: if IsDirSynced missed one, the write-scope/synced error means AD owns it.
            elseif ($m -match 'being synchronized|out of the current user.s write scope|on-?prem') {
                $skipped++; $actions.Add("skipped on-prem-synced group (AD lane owns it): $($g.DisplayName)"); Write-CtgStep "– on-prem group (AD lane owns it): $($g.DisplayName)"
            }
            else { $actions.Add("WARN dist group '$($g.DisplayName)': $m"); Write-CtgStep "✗ group: $($g.DisplayName) — $m" }
        }
    }
    $actions.Add("distribution/mail-enabled mirror from ${MirrorUser}: $copied added, $skipped on-prem (AD lane) — of $($groups.Count) cloud-only")
    return $actions.ToArray()
}

function Invoke-CtgExchangeSharedMailboxMirror {
    <#
    .SYNOPSIS
        Grant the new user the SHARED-MAILBOX permissions the mirror user has — FullAccess, SendAs and
        SendOnBehalf — across every shared mailbox in the tenant. Idempotent: a permission is only added
        when the mirror user has it AND the new user doesn't. Mirrors the manual mirror script.
    .NOTES
        Needs Exchange Online (the same app-only connection the DL adds use). Matching is identifier-
        tolerant: a permission's User/Trustee matches the mirror/target by UPN, SMTP, alias, name or DN
        (EXO stores different forms in different places), so a name spelled differently still resolves.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$MirrorUser, [Parameter(Mandatory)][string]$NewUser)
    $actions = [System.Collections.Generic.List[string]]::new()
    $ref = Get-Recipient -Identity $MirrorUser -ErrorAction SilentlyContinue
    if (-not $ref) { $actions.Add("WARN mirror user not found in Exchange (shared mailboxes): $MirrorUser"); return $actions.ToArray() }
    $tgt = Get-Recipient -Identity $NewUser -ErrorAction SilentlyContinue

    # Every identifier EXO might record a permission under, lowercased, so matching is form-agnostic.
    # Get-CtgProp keeps this StrictMode-safe when a recipient object lacks one of the properties.
    $idsOf = {
        param($r, $raw)
        $fields = @('PrimarySmtpAddress', 'UserPrincipalName', 'WindowsLiveID', 'Name', 'Alias', 'DistinguishedName', 'ExternalDirectoryObjectId')
        @(@($raw) + @($fields | ForEach-Object { Get-CtgProp $r $_ })) |
            Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() } | Select-Object -Unique
    }
    $mirrorIds = @(& $idsOf $ref $MirrorUser)
    $targetIds = @(& $idsOf $tgt $NewUser)
    $isMirror = { param($u) $u -and (([string]$u).ToLowerInvariant() -in $mirrorIds) }
    $isTarget = { param($u) $u -and (([string]$u).ToLowerInvariant() -in $targetIds) }

    Write-CtgStep "mirroring shared-mailbox permissions from $($ref.DisplayName)"
    $shared = @(Get-Mailbox -RecipientTypeDetails SharedMailbox -ResultSize Unlimited -ErrorAction SilentlyContinue)
    $full = 0; $sa = 0; $sob = 0
    foreach ($mbx in $shared) {
        $name = $mbx.DisplayName
        try {
            # FULL ACCESS — explicit (non-inherited) grants only, same as the manual script.
            $perms = @(Get-MailboxPermission -Identity $mbx.Identity -ErrorAction SilentlyContinue | Where-Object { -not $_.IsInherited -and ($_.AccessRights -contains 'FullAccess') })
            if (@($perms | Where-Object { & $isMirror $_.User }).Count) {
                if (@($perms | Where-Object { & $isTarget $_.User }).Count) { $actions.Add("already FullAccess: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "FullAccess on $name")) {
                    Add-MailboxPermission -Identity $mbx.Identity -User $NewUser -AccessRights FullAccess -InheritanceType All -AutoMapping:$true -Confirm:$false -ErrorAction Stop | Out-Null
                    $actions.Add("shared mailbox FullAccess: $name"); Write-CtgStep "✓ FullAccess: $name"; $full++
                }
            }
            # SEND AS
            $rperms = @(Get-RecipientPermission -Identity $mbx.Identity -ErrorAction SilentlyContinue | Where-Object { $_.AccessRights -contains 'SendAs' })
            if (@($rperms | Where-Object { & $isMirror $_.Trustee }).Count) {
                if (@($rperms | Where-Object { & $isTarget $_.Trustee }).Count) { $actions.Add("already SendAs: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "SendAs on $name")) {
                    Add-RecipientPermission -Identity $mbx.Identity -Trustee $NewUser -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null
                    $actions.Add("shared mailbox SendAs: $name"); Write-CtgStep "✓ SendAs: $name"; $sa++
                }
            }
            # SEND ON BEHALF — stored on the mailbox; add the new user without clobbering the list.
            $sobList = @($mbx.GrantSendOnBehalfTo)
            if (@($sobList | Where-Object { & $isMirror $_ }).Count) {
                if (@($sobList | Where-Object { & $isTarget $_ }).Count) { $actions.Add("already SendOnBehalf: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "SendOnBehalf on $name")) {
                    Set-Mailbox -Identity $mbx.Identity -GrantSendOnBehalfTo @{ Add = $NewUser } -ErrorAction Stop
                    $actions.Add("shared mailbox SendOnBehalf: $name"); Write-CtgStep "✓ SendOnBehalf: $name"; $sob++
                }
            }
        } catch {
            $actions.Add("WARN shared mailbox '$name': $($_.Exception.Message)"); Write-CtgStep "✗ $name — $($_.Exception.Message)"
        }
    }
    $actions.Add("shared-mailbox mirror from ${MirrorUser}: $full FullAccess, $sa SendAs, $sob SendOnBehalf added (of $($shared.Count) shared mailboxes)")
    return $actions.ToArray()
}

function Invoke-CtgExchangeNamedGroups {
    # Add the new user to EXPLICITLY-REQUESTED groups BY NAME over Exchange Online — the groups the
    # Graph/m365 lane couldn't write (DLs/mail-enabled) or couldn't resolve (a 365 group whose alias
    # != displayName). Each name is resolved in EXO; a DL/mail-enabled group -> Add-DistributionGroupMember,
    # a 365 (Unified) group -> Add-UnifiedGroupLinks; dir-synced ones are left to the AD lane; a pure
    # security group is the Graph lane's job; and a name EXO doesn't recognize is surfaced (not silent).
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$NewUser, [string[]]$Groups)
    $actions = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @($Groups | Where-Object { $_ })) {
        $r = Get-Recipient -Identity $name -ErrorAction SilentlyContinue
        if (-not $r) { $actions.Add("WARN requested group '$name' not found in Exchange Online — check the exact display name / that it's an EXO distribution list"); Write-CtgStep "✗ group not found in EXO: $name"; continue }
        if ($r.IsDirSynced) { $actions.Add("skipped on-prem-synced group (AD lane owns it): $name"); continue }
        $type = [string]$r.RecipientTypeDetails
        if ($type -eq 'GroupMailbox') {
            # A Microsoft 365 (Unified) group: EXO resolved it (often by alias) where Graph's exact
            # displayName match missed it, so it landed here. 365 group membership is added via EXO's
            # Add-UnifiedGroupLinks (NOT Add-DistributionGroupMember).
            if (-not $PSCmdlet.ShouldProcess($NewUser, "Add to 365 group $name")) { continue }
            try {
                Add-UnifiedGroupLinks -Identity $r.Identity -LinkType Members -Links $NewUser -ErrorAction Stop
                $actions.Add("added to 365 group: $name"); Write-CtgStep "✓ added to 365 group: $name"
            } catch {
                $m = $_.Exception.Message
                if ($m -match 'already') { $actions.Add("already in 365 group: $name"); Write-CtgStep "– already a member: $name" }
                else { $actions.Add("WARN 365 group '$name': $m"); Write-CtgStep "✗ 365 group '$name': $m" }
            }
            continue
        }
        if ($type -notin @('MailUniversalDistributionGroup', 'MailUniversalSecurityGroup', 'RoomList')) {
            $actions.Add("skipped '$name' — not a distribution / mail-enabled / 365 group ($type); a pure security group is added by the m365/Graph lane"); continue
        }
        if (-not $PSCmdlet.ShouldProcess($NewUser, "Add to $name")) { continue }
        try {
            Add-DistributionGroupMember -Identity $r.Identity -Member $NewUser -BypassSecurityGroupManagerCheck -ErrorAction Stop
            $actions.Add("added to distribution group: $name"); Write-CtgStep "✓ added to DL: $name"
        } catch {
            $m = $_.Exception.Message
            if ($m -match 'already a member') { $actions.Add("already in group: $name"); Write-CtgStep "– already a member: $name" }
            else { $actions.Add("WARN distribution group '$name': $m"); Write-CtgStep "✗ DL '$name': $m" }
        }
    }
    return $actions.ToArray()
}

# Names of the requested groups from config (entries may be plain strings or { name, type } objects).
function Get-CtgRequestedGroupNames {
    param([pscustomobject]$Config)
    @(@(Get-CtgProp $Config 'namedGroups') + @(Get-CtgProp $Config 'groups') | ForEach-Object {
            if ($_ -is [string]) { $_ } else { [string](Get-CtgProp $_ 'name') }
        } | Where-Object { $_ } | Select-Object -Unique)
}

# CLOUD (Exchange Online) onboard: no on-prem remote mailbox — the M365 license already created the
# mailbox. Just do the EXO-only work: add the user to the requested distribution lists by name (+
# mirror a reference user if set). Used when the job brokered no on-prem Exchange session.
function Invoke-CtgExchangeCloudOnboard {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName
    $names = @(Get-CtgRequestedGroupNames -Config $Config)
    if ($names.Count -gt 0) { $g = Invoke-CtgExchangeNamedGroups -NewUser $email -Groups $names; if ($g) { $actions.AddRange([string[]]$g) } }
    else { $actions.Add("no distribution lists requested for this user") }
    $mirror = Get-CtgProp $Config 'mirrorFromUser'
    if ($mirror) { $m = Invoke-CtgExchangeDistListMirror -MirrorUser $mirror -NewUser $email; if ($m) { $actions.AddRange([string[]]$m) } }
    return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

# Combined hybrid onboard, one job across the AAD Connect sync boundary: enable the remote mailbox,
# block until it lands in EXO (config-gated — skipped when Config.waitForSync is false), then finish
# regional + manager-calendar. A mailbox that doesn't sync before the timeout is NOT an error: the
# regional/calendar step is deferred (re-running the idempotent job finishes it once sync catches up).
function Invoke-CtgExchangeHybridOnboard {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        # Optional: a scriptblock that triggers an Entra Connect delta sync. Called AFTER the remote
        # mailbox is enabled and BEFORE the mailbox-sync wait, so the new mailbox provisions into the
        # cloud in this same pass instead of waiting on the next scheduled sync (or a manual re-run).
        [scriptblock]$TriggerSync
    )
    $enable = Invoke-CtgExchangeOnboarding -User $User -Config $Config
    $identity = $User.SamAccountName
    $actions = [System.Collections.Generic.List[string]]::new()
    if ($enable.Actions) { $actions.AddRange([string[]]$enable.Actions) }

    # Dry run: Enable-RemoteMailbox was WhatIf'd so no mailbox will ever sync — don't block the full
    # sync timeout (up to 10 min) waiting for something that was never created. Regional/calendar are
    # ShouldProcess-gated below, so they no-op under -WhatIf too.
    if ($WhatIfPreference) {
        $actions.Add("dry run — skipped sync trigger + mailbox wait + regional/calendar (nothing was created)")
        Write-CtgStep "✓ dry run complete — would enable remote mailbox $($enable.Email), trigger a delta sync, then set regional/calendar (no changes made)"
        return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enable.Email; Routing = $enable.Routing; Actions = $actions.ToArray() }
    }

    # Push the just-enabled mailbox up to the cloud now (3b), so the wait below actually finds it.
    if ($TriggerSync) {
        try {
            Write-CtgStep "triggering Entra Connect delta sync so the new mailbox provisions in Exchange Online"
            & $TriggerSync
            $actions.Add("triggered Entra Connect delta sync")
        } catch {
            # A sync failure isn't fatal here — the wait/timeout + deferral path still applies.
            $actions.Add("delta sync trigger failed ($($_.Exception.Message)) — falling back to the scheduled sync")
        }
    }

    if ((Get-CtgProp $Config 'waitForSync') -ne $false) {
        $wait = Wait-CtgMailbox -Identity $identity -TimeoutSeconds ([int]((Get-CtgProp $Config 'syncTimeoutSeconds') ?? 600))
        $actions.Add("mailbox sync: $($wait.Status)")
        if (-not $wait.Found) {
            Write-CtgStep "⚠ remote mailbox enabled ($($enable.Email)) but it hasn't synced to Exchange Online yet — regional/calendar deferred; run a directory sync, then re-run this step"
            return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enable.Email; Routing = $enable.Routing; Actions = $actions.ToArray(); Warning = 'mailbox not synced before timeout — regional/calendar deferred to a re-run' }
        }
    }

    $regional = Set-CtgMailboxRegional -Identity $identity -Config $Config -ManagerEmail ([string](Get-CtgProp $User 'ManagerEmail'))
    if ($regional.Actions) { $actions.AddRange([string[]]$regional.Actions) }

    # Mirror the reference user's distribution lists + mail-enabled security groups (the EXO-managed
    # groups the Graph/m365 lane couldn't add). The mailbox now exists, so the new user is a valid
    # recipient. A failure here is non-fatal (the rest of the onboard already succeeded).
    # Explicitly-requested distribution lists (by name), then the reference-user mirror.
    $reqNames = @(Get-CtgRequestedGroupNames -Config $Config)   # @() — an empty function result collapses to $null otherwise
    if ($reqNames.Count -gt 0 -and $enable.Email) {
        try { foreach ($a in (Invoke-CtgExchangeNamedGroups -NewUser ([string]$enable.Email) -Groups $reqNames)) { $actions.Add($a) } }
        catch { $actions.Add("WARN requested distribution lists failed: $($_.Exception.Message)") }
    }
    $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
    if ($mirrorUser -and $enable.Email) {
        try { foreach ($a in (Invoke-CtgExchangeDistListMirror -MirrorUser ([string]$mirrorUser) -NewUser ([string]$enable.Email))) { $actions.Add($a) } }
        catch { $actions.Add("WARN distribution mirror failed: $($_.Exception.Message)") }
    }

    Write-CtgStep "✓ exchange onboard complete — mailbox $($enable.Email) live; $($actions -join '; ')"
    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enable.Email; Routing = $enable.Routing; Actions = $actions.ToArray() }
}

# Sync-wait: after Azure AD Connect runs a delta, poll Exchange Online until the new user's mailbox
# appears (the script's `Do { Start-Sleep 30; Get-Mailbox } While ($null)` — but app-orchestrated,
# bounded, never an open-ended sleep). Returns Found/timeout so the runner can decide to proceed to
# the post-sync regional/calendar step or surface a slow sync.
function Wait-CtgMailbox {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Identity, [int]$TimeoutSeconds = 600, [int]$IntervalSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $start = Get-Date
    while ($true) {
        $mbx = Get-Mailbox -Identity $Identity -ErrorAction SilentlyContinue
        if ($mbx) { return [pscustomobject]@{ Status = 'ok'; Found = $true; Identity = $Identity } }
        if ((Get-Date) -ge $deadline) { return [pscustomobject]@{ Status = 'timeout'; Found = $false; Identity = $Identity } }
        # Heartbeat so the run report shows the wait is alive, not hung (Send-CtgProgress is provided
        # by the runner; absent under Pester, so guard it). Reports elapsed / remaining each poll.
        if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) {
            $elapsed = [int]((Get-Date) - $start).TotalSeconds
            $remain = [int]($deadline - (Get-Date)).TotalSeconds
            Send-CtgProgress "waiting for mailbox to sync into Exchange Online — ${elapsed}s elapsed, retrying (timeout in ${remain}s)"
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}

function Invoke-CtgExchangeOffboarding {
    <#
    .SYNOPSIS
        Idempotent Exchange Online offboard.
    .PARAMETER Config
        convertToShared{skipIfMailboxOverGB}, blockMobileDevices, autoReply{message},
        forwarding{address, keepCopy}.
    .PARAMETER TriggerSync
        Optional delta-sync scriptblock — invoked after a HYBRID (on-prem) convert so the change
        propagates to the cloud promptly. Cloud-only offboards don't pass it.
    .OUTPUTS
        Result with Status, MailboxSizeGB (so the m365 module can honor the keep-license rule),
        and an Actions log.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [scriptblock]$TriggerSync
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = [string]$User.UserPrincipalName
    # Resolve by DISPLAY NAME when the case has no UPN (offboard intakes often carry only the name).
    if ([string]::IsNullOrWhiteSpace($upn)) {
        $dn = [string](Get-CtgProp $User 'DisplayName')
        if ($dn) {
            $rcpt = @(Get-Recipient -Filter "DisplayName -eq '$dn'" -ErrorAction SilentlyContinue)
            if ($rcpt.Count -eq 1) {
                $upn = [string]((Get-CtgProp $rcpt[0] 'PrimarySmtpAddress') ?? (Get-CtgProp $rcpt[0] 'WindowsLiveID') ?? (Get-CtgProp $rcpt[0] 'Identity'))
                $actions.Add("resolved offboard target by display name '$dn' -> $upn")
            }
            elseif ($rcpt.Count -gt 1) {
                $actions.Add("WARN $($rcpt.Count) recipients match display name '$dn' — set the exact UPN on the case. Nothing done.")
                return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Upn = ''; MailboxSizeGB = 0; Actions = $actions.ToArray() }
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($upn)) {
        $actions.Add("WARN no user identity on the case (no UPN, and no display-name match) — set the offboard target's email/UPN on the case, then re-run. Nothing done.")
        return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Upn = $upn; MailboxSizeGB = 0; Actions = $actions.ToArray() }
    }
    $sizeGB = Get-CtgMailboxSizeGB -Identity $upn
    $actions.Add("mailbox size: $sizeGB GB")

    # 1. Convert to shared — unless over the threshold ------------------------
    $cts = Get-CtgProp $Config 'convertToShared'
    if ($cts) {
        $threshold = [double]((Get-CtgProp $cts 'skipIfMailboxOverGB') ?? 50)
        if ($sizeGB -gt $threshold) {
            $actions.Add("mailbox $sizeGB GB over threshold ($threshold GB) — kept as a user mailbox; license stays")
        }
        else {
            # HYBRID (on-prem-mastered) mailbox: an EXO Set-Mailbox -Type Shared is overwritten by AD
            # Connect, so convert via Set-RemoteMailbox ON-PREM, then trigger a delta sync to push it.
            # Detect by the on-prem session: when Connect-CtgExchangeOnPrem ran it imported
            # *-RemoteMailbox, and Get-RemoteMailbox returns the object for an on-prem-mastered mailbox.
            # Cloud-mastered mailboxes (no on-prem session, or no remote object) take the EXO path.
            $remote = $null
            if (Get-Command Get-RemoteMailbox -ErrorAction SilentlyContinue) {
                $remote = Get-RemoteMailbox -Identity $upn -ErrorAction SilentlyContinue
            }
            if ($remote) {
                if ($PSCmdlet.ShouldProcess($upn, "Convert mailbox to shared (on-prem Set-RemoteMailbox)")) {
                    Set-RemoteMailbox -Identity $upn -Type Shared
                    $actions.Add("converted mailbox to shared on-prem (Set-RemoteMailbox -Type Shared)")
                    if ($TriggerSync) {
                        try { & $TriggerSync; $actions.Add("triggered Entra Connect delta sync to push the shared conversion") }
                        catch { $actions.Add("WARN convert synced on next cycle — delta-sync trigger failed: $($_.Exception.Message)") }
                    }
                }
            }
            elseif ($PSCmdlet.ShouldProcess($upn, "Convert mailbox to shared")) {
                Set-Mailbox -Identity $upn -Type Shared
                $actions.Add("converted mailbox to shared")
            }
        }
    }

    # 1b. Grant the manager Full Access to the mailbox (so they can retrieve mail) -------
    # config.delegateManagerFullAccess: $true uses the case's manager; a string sets an explicit
    # address. AutoMapping adds the mailbox to the manager's Outlook automatically. Idempotent.
    $delegate = Get-CtgProp $Config 'delegateManagerFullAccess'
    if ($delegate) {
        $mgr =
            if ($delegate -is [string]) { $delegate }
            elseif (Get-CtgProp $delegate 'address') { [string](Get-CtgProp $delegate 'address') }
            else { [string]((Get-CtgProp $User 'ManagerEmail') ?? (Get-CtgProp $User 'ManagerUpn') ?? (Get-CtgProp $User 'Manager')) }
        if (-not $mgr) {
            $actions.Add("WARN delegateManagerFullAccess set but no manager on the case — Full Access delegate skipped")
        }
        else {
            $already = @(Get-MailboxPermission -Identity $upn -ErrorAction SilentlyContinue) |
                Where-Object { (@($_.AccessRights) -contains 'FullAccess') -and ("$($_.User)" -eq $mgr -or "$($_.User)" -like "*$mgr*") }
            if ($already) {
                $actions.Add("manager $mgr already has Full Access — no change")
            }
            elseif ($PSCmdlet.ShouldProcess($upn, "Grant $mgr Full Access")) {
                try {
                    Add-MailboxPermission -Identity $upn -User $mgr -AccessRights FullAccess -AutoMapping:$true -ErrorAction Stop | Out-Null
                    $actions.Add("granted manager $mgr Full Access to the mailbox (AutoMapping on)")
                }
                catch { $actions.Add("WARN could not grant $mgr Full Access: $($_.Exception.Message)") }
            }
        }
    }

    # 2. On-request out-of-office --------------------------------------------
    $autoReply = Get-CtgProp $Config 'autoReply'
    $message = if ($autoReply) { Get-CtgProp $autoReply 'message' } else { $null }
    if ($message -and $PSCmdlet.ShouldProcess($upn, "Set out-of-office")) {
        Set-MailboxAutoReplyConfiguration -Identity $upn -AutoReplyState Enabled -InternalMessage $message -ExternalMessage $message
        $actions.Add("set out-of-office reply")
    }

    # 3. On-request forwarding ------------------------------------------------
    $forwarding = Get-CtgProp $Config 'forwarding'
    $fwdAddr = if ($forwarding) { Get-CtgProp $forwarding 'address' } else { $null }
    if ($fwdAddr -and $PSCmdlet.ShouldProcess($upn, "Forward to $fwdAddr")) {
        $keepCopy = [bool](Get-CtgProp $forwarding 'keepCopy')
        Set-Mailbox -Identity $upn -ForwardingSmtpAddress $fwdAddr -DeliverToMailboxAndForward:$keepCopy
        $actions.Add("forwarding to $fwdAddr (keep copy: $keepCopy)")
    }

    # 4. Block mobile devices / OWA ------------------------------------------
    if ((Get-CtgProp $Config 'blockMobileDevices') -ne $false) {
        if ($PSCmdlet.ShouldProcess($upn, "Disable ActiveSync + OWA")) {
            Set-CASMailbox -Identity $upn -ActiveSyncEnabled $false -OWAEnabled $false
            $actions.Add("disabled ActiveSync and OWA")
        }
    }

    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Upn = $upn; MailboxSizeGB = $sizeGB; Actions = $actions.ToArray() }
}

function Confirm-CtgExchange {
    <#
    .SYNOPSIS
        Post-action read-back for Exchange Online offboard. No mutations; returns { ok; checks[] }.
        Mailbox is Shared (or kept as a user mailbox when over the size threshold), and
        ActiveSync + OWA are disabled.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }

    # Exchange has no onboard lane (the mailbox is created with the M365 user).
    if ($Action -eq 'onboard') { return [pscustomobject]@{ ok = $true; checks = @() } }

    $upn = $User.UserPrincipalName
    $mbx = Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue
    $cts = Get-CtgProp $Config 'convertToShared'
    if ($cts) {
        $threshold = [double]((Get-CtgProp $cts 'skipIfMailboxOverGB') ?? 50)
        $sizeGB = Get-CtgMailboxSizeGB -Identity $upn
        if ($sizeGB -gt $threshold) {
            & $add "mailbox kept (>$threshold GB)" $true $true   # over-threshold mailboxes are intentionally not converted
        }
        else {
            & $add 'mailbox is shared' 'SharedMailbox' ([string](Get-CtgProp $mbx 'RecipientTypeDetails'))
        }
    }
    if ((Get-CtgProp $Config 'blockMobileDevices') -ne $false) {
        $cas = Get-CASMailbox -Identity $upn -ErrorAction SilentlyContinue
        & $add 'ActiveSync disabled' $false ([bool](Get-CtgProp $cas 'ActiveSyncEnabled'))
        & $add 'OWA disabled' $false ([bool](Get-CtgProp $cas 'OWAEnabled'))
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgExchange, Connect-CtgExchangeOnPrem, Get-CtgMailboxSizeGB, Invoke-CtgExchangeOnboarding, Invoke-CtgExchangeHybridOnboard, Invoke-CtgExchangeCloudOnboard, Invoke-CtgExchangeNamedGroups, Invoke-CtgExchangeDistListMirror, Invoke-CtgExchangeSharedMailboxMirror, Set-CtgMailboxRegional, Wait-CtgMailbox, Invoke-CtgExchangeOffboarding, Confirm-CtgExchange
