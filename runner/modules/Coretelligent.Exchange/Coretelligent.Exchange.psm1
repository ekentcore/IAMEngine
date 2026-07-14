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
    # IDictionary (not just [hashtable]): Graph's AdditionalProperties is a generic Dictionary, so a
    # [hashtable]-only check would miss its keys (e.g. the manager's mail/userPrincipalName).
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Narrate a step into the live run-report progress. Send-CtgProgress is the runner's global poster;
# it's absent under Pester, so guard it — narration must never affect the executor's behavior.
function Write-CtgStep([string]$Message) {
    if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress $Message }
}

# Resolve the offboard target's mailbox identity ONCE, used by BOTH the executor and the validator so
# they never disagree (a validator that resolved differently would always "miss" and trigger the
# idempotent re-run loop — running Get-Recipient/Set-Mailbox several times). Returns
# @{ Upn; MatchCount; DisplayName }: the UPN from the case when present, else by DISPLAY NAME via
# Get-Recipient (exactly-one match wins; 0/many -> Upn '').
function Resolve-CtgExchangeTarget {
    param([pscustomobject]$User)
    # Every read goes through Get-CtgProp: an offboard payload is not identity-derived and a ServiceNow
    # UM intake carries the leaver ONLY as `userToOffboard` — no UserPrincipalName property at all, and
    # under StrictMode a dot-read of an absent property throws. `userToOffboard` is the last link in BOTH
    # chains (it holds an email when the SNOW contact resolved one, else the display name), otherwise
    # this resolves to nothing and the offboard silently no-ops.
    $firstOf = { param($Names) @($Names | ForEach-Object { Get-CtgProp $User $_ }) | Where-Object { $_ } | Select-Object -First 1 }
    $upn = [string](& $firstOf @('UserPrincipalName', 'email', 'WorkEmail'))
    $dn = [string](& $firstOf @('DisplayName', 'userToOffboard'))
    if ([string]::IsNullOrWhiteSpace($upn) -and $dn -match '@') { $upn = $dn; $dn = '' }   # an email in the name slot IS the identity
    if (-not [string]::IsNullOrWhiteSpace($upn)) { return @{ Upn = $upn; MatchCount = 1; DisplayName = '' } }
    if (-not $dn) { return @{ Upn = ''; MatchCount = 0; DisplayName = '' } }
    $safe = $dn -replace "'", "''"   # escape quotes so a name like "Sean O'Brien" can't break the OPATH filter
    $rcpt = @(Get-Recipient -Filter "DisplayName -eq '$safe'" -ErrorAction SilentlyContinue)
    $u = if ($rcpt.Count -eq 1) { [string]((Get-CtgProp $rcpt[0] 'PrimarySmtpAddress') ?? (Get-CtgProp $rcpt[0] 'WindowsLiveID') ?? (Get-CtgProp $rcpt[0] 'Identity')) } else { '' }
    return @{ Upn = $u; MatchCount = $rcpt.Count; DisplayName = $dn }
}

# Candidates to offer a human when the name on the ticket matches NO recipient (or several). An exact
# DisplayName search has already failed, so repeating it cannot help: each token of the name is tried as
# a wildcard against DisplayName / Name, and the union comes back for the operator to pick from. @()
# when nothing is close.
function Get-CtgExchangeOffboardCandidates {
    param([string]$Name, [int]$Limit = 10)
    if ([string]::IsNullOrWhiteSpace($Name)) { return @() }
    $tokens = @($Name -split '\s+' | Where-Object { $_.Length -ge 2 })
    $found = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($t in $tokens) {
        $esc = $t -replace "'", "''"
        foreach ($field in @('DisplayName', 'Name')) {
            # A failing probe must not lose the candidates the other probes found.
            try { $hits = @(Get-Recipient -Filter "$field -like '*$esc*'" -ResultSize $Limit -ErrorAction Stop) }
            catch { continue }
            foreach ($r in $hits) {
                $addr = [string]((Get-CtgProp $r 'PrimarySmtpAddress') ?? (Get-CtgProp $r 'WindowsLiveID') ?? (Get-CtgProp $r 'Identity'))
                if ($addr -and $seen.Add($addr)) {
                    $found.Add([pscustomobject]@{
                        id          = $addr
                        upn         = $addr
                        displayName = [string](Get-CtgProp $r 'DisplayName')
                        jobTitle    = [string](Get-CtgProp $r 'Title')
                        department  = [string](Get-CtgProp $r 'Department')
                        mail        = $addr
                        enabled     = $true   # Get-Recipient doesn't carry sign-in state; the m365 lane does
                        source      = 'exchange'
                    })
                }
            }
        }
    }
    @($found | Select-Object -First $Limit)
}

# Resolve the departing user's MANAGER to a primary SMTP address, trying the authoritative sources in
# order: Entra via Microsoft Graph FIRST (Get-MgUserManager — the manager link Exchange's
# Get-User.Manager frequently OMITS for cloud-managed users, which is why a delegate was being skipped
# even though Entra had a manager), then Exchange's directory view (Get-User.Manager -> Get-Recipient),
# then on-prem AD (Get-ADUser.Manager, on a client-network agent). Returns '' only when NO source has a
# manager. Each cmdlet is probed with Get-Command so a runner missing Graph/AD just falls through.
function Resolve-CtgManagerAddress {
    param([string]$Upn)
    if ([string]::IsNullOrWhiteSpace($Upn)) { return '' }

    # 1) Entra via Microsoft Graph — authoritative for the cloud manager relationship. Graph is
    #    connected by the entra/m365 step that runs before Exchange in the same runner process.
    if (Get-Command Get-MgUserManager -ErrorAction SilentlyContinue) {
        try {
            $m = Get-MgUserManager -UserId $Upn -ErrorAction Stop
            $ap = Get-CtgProp $m 'AdditionalProperties'
            $addr = [string]((Get-CtgProp $ap 'mail') ?? (Get-CtgProp $ap 'userPrincipalName'))
            if (-not $addr) { $addr = [string]((Get-CtgProp $m 'Mail') ?? (Get-CtgProp $m 'UserPrincipalName')) }
            if ($addr) { return $addr }
        }
        catch { }
    }

    # 2) Exchange Online directory view — Get-User.Manager is a name/DN; resolve it to a primary SMTP.
    if (Get-Command Get-User -ErrorAction SilentlyContinue) {
        $mgrId = [string](Get-CtgProp (Get-User -Identity $Upn -ErrorAction SilentlyContinue) 'Manager')
        if ($mgrId) {
            $rcpt = if (Get-Command Get-Recipient -ErrorAction SilentlyContinue) { Get-Recipient -Identity $mgrId -ErrorAction SilentlyContinue } else { $null }
            $addr = [string]((Get-CtgProp $rcpt 'PrimarySmtpAddress') ?? $mgrId)
            if ($addr) { return $addr }
        }
    }

    # 3) On-prem AD (client-network agent with RSAT) — the manager DN -> the manager's mail/UPN.
    if (Get-Command Get-ADUser -ErrorAction SilentlyContinue) {
        try {
            $esc = $Upn -replace "'", "''"
            $u = Get-ADUser -Filter "UserPrincipalName -eq '$esc'" -Properties Manager -ErrorAction SilentlyContinue
            $mgrDn = [string](Get-CtgProp $u 'Manager')
            if ($mgrDn) {
                $mgrU = Get-ADUser -Identity $mgrDn -Properties mail, UserPrincipalName -ErrorAction SilentlyContinue
                $addr = [string]((Get-CtgProp $mgrU 'mail') ?? (Get-CtgProp $mgrU 'UserPrincipalName'))
                if ($addr) { return $addr }
            }
        }
        catch { }
    }

    return ''
}

# Resolve a person's DISPLAY NAME to a mailbox address. The ServiceNow intake carries the manager as a
# NAME (payload `managerName`, e.g. "Elizabeth McPhillips") and NEVER as an address — so a delegate
# grant that only understood addresses skipped the very manager the form named. Exactly-one match wins;
# 0 or several return '' — we never guess who gets access to someone's mailbox. EXO first, then on-prem
# AD (hybrid clients, where the manager may not be mail-enabled in the cloud view).
function Resolve-CtgAddressByDisplayName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    $safe = $Name -replace "'", "''"   # "Sean O'Brien" must not break the OPATH/LDAP filter
    if (Get-Command Get-Recipient -ErrorAction SilentlyContinue) {
        $rcpt = @(Get-Recipient -Filter "DisplayName -eq '$safe'" -ErrorAction SilentlyContinue)
        if ($rcpt.Count -gt 1) { Write-Warning "manager '$Name' is ambiguous in Exchange ($($rcpt.Count) matches) — not guessing"; return '' }
        if ($rcpt.Count -eq 1) {
            $addr = [string]((Get-CtgProp $rcpt[0] 'PrimarySmtpAddress') ?? (Get-CtgProp $rcpt[0] 'WindowsLiveID'))
            if ($addr) { return $addr }
        }
    }
    if (Get-Command Get-ADUser -ErrorAction SilentlyContinue) {
        try {
            $u = @(Get-ADUser -Filter "DisplayName -eq '$safe'" -Properties mail, UserPrincipalName -ErrorAction SilentlyContinue)
            if ($u.Count -eq 1) {
                $addr = [string]((Get-CtgProp $u[0] 'mail') ?? (Get-CtgProp $u[0] 'UserPrincipalName'))
                if ($addr) { return $addr }
            }
        }
        catch { }
    }
    return ''
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
    # Identity is intentionally NOT [Mandatory]: a Mandatory string param throws a hard
    # "Cannot bind argument to parameter 'Identity' because it is an empty string" on an empty value,
    # which is an opaque crash. Return 0 for an empty/absent identity instead — the caller decides.
    [CmdletBinding()]
    param([string]$Identity)
    if ([string]::IsNullOrWhiteSpace($Identity)) { return 0 }
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

    $shared = @(Get-Mailbox -RecipientTypeDetails SharedMailbox -ResultSize Unlimited -ErrorAction SilentlyContinue)
    # This loop does ~2 EXO reads per mailbox, so on a big tenant it's a multi-minute scan that emits
    # output ONLY when it changes a permission — which reads as "stuck". Tell the operator the size up
    # front, then heartbeat as it scans ("checked N/total (P%) — at <mailbox>") so the run report shows
    # live movement, names WHERE it is if it wedges, and the stall watchdog keeps its heartbeat. The
    # cadence is ADAPTIVE — ~30 updates across the whole set regardless of size (every mailbox for a
    # small tenant, ~every 6 for a big one) so it always reads as progressing, not frozen.
    Write-CtgStep "mirroring shared-mailbox permissions from $($ref.DisplayName) — scanning $($shared.Count) shared mailboxes (this can take a few minutes)"
    $full = 0; $sa = 0; $sob = 0; $idx = 0
    $tick = [Math]::Max(1, [int][Math]::Ceiling($shared.Count / 30))
    foreach ($mbx in $shared) {
        $idx++
        $name = $mbx.DisplayName
        if ($idx % $tick -eq 0 -or $idx -eq $shared.Count) {
            $pct = if ($shared.Count) { [int](($idx / $shared.Count) * 100) } else { 100 }
            Write-CtgStep "checked $idx/$($shared.Count) shared mailboxes ($pct%) — at $name"
        }
        # Use a GUARANTEED-UNIQUE identity for the per-mailbox cmdlets: a mailbox's .Identity is often
        # its Name/alias, which is ambiguous when another recipient shares it (e.g. a "Finance" shared
        # mailbox AND a "finance" DL) -> "object: 'finance' matches multiple entries". ExchangeGuid is
        # unique to this mailbox; fall back to PrimarySmtpAddress, then Guid, then Identity.
        $mbxId = @(
            (Get-CtgProp $mbx 'ExchangeGuid'), (Get-CtgProp $mbx 'PrimarySmtpAddress'),
            (Get-CtgProp $mbx 'Guid'), (Get-CtgProp $mbx 'Identity')
        ) | ForEach-Object { [string]$_ } | Where-Object { $_ } | Select-Object -First 1
        try {
            # FULL ACCESS — explicit (non-inherited) grants only, same as the manual script.
            $perms = @(Get-MailboxPermission -Identity $mbxId -ErrorAction SilentlyContinue | Where-Object { -not $_.IsInherited -and ($_.AccessRights -contains 'FullAccess') })
            if (@($perms | Where-Object { & $isMirror $_.User }).Count) {
                if (@($perms | Where-Object { & $isTarget $_.User }).Count) { $actions.Add("already FullAccess: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "FullAccess on $name")) {
                    Add-MailboxPermission -Identity $mbxId -User $NewUser -AccessRights FullAccess -InheritanceType All -AutoMapping:$true -Confirm:$false -ErrorAction Stop | Out-Null
                    $actions.Add("shared mailbox FullAccess: $name"); Write-CtgStep "✓ FullAccess: $name"; $full++
                }
            }
            # SEND AS
            $rperms = @(Get-RecipientPermission -Identity $mbxId -ErrorAction SilentlyContinue | Where-Object { $_.AccessRights -contains 'SendAs' })
            if (@($rperms | Where-Object { & $isMirror $_.Trustee }).Count) {
                if (@($rperms | Where-Object { & $isTarget $_.Trustee }).Count) { $actions.Add("already SendAs: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "SendAs on $name")) {
                    Add-RecipientPermission -Identity $mbxId -Trustee $NewUser -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null
                    $actions.Add("shared mailbox SendAs: $name"); Write-CtgStep "✓ SendAs: $name"; $sa++
                }
            }
            # SEND ON BEHALF — stored on the mailbox; add the new user without clobbering the list.
            $sobList = @($mbx.GrantSendOnBehalfTo)
            if (@($sobList | Where-Object { & $isMirror $_ }).Count) {
                if (@($sobList | Where-Object { & $isTarget $_ }).Count) { $actions.Add("already SendOnBehalf: $name") }
                elseif ($PSCmdlet.ShouldProcess($NewUser, "SendOnBehalf on $name")) {
                    Set-Mailbox -Identity $mbxId -GrantSendOnBehalfTo @{ Add = $NewUser } -ErrorAction Stop
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
    # StrictMode-safe: Invoke-CtgExchangeOnboarding returns NO Email/Routing when there's no
    # enableRemoteMailbox config (or no routing domain) — read them defensively so a config-less lane
    # doesn't crash with "property 'Email' cannot be found".
    $enableEmail = [string](Get-CtgProp $enable 'Email')
    $enableRouting = [string](Get-CtgProp $enable 'Routing')

    # Dry run: Enable-RemoteMailbox was WhatIf'd so no mailbox will ever sync — don't block the full
    # sync timeout (up to 10 min) waiting for something that was never created. Regional/calendar are
    # ShouldProcess-gated below, so they no-op under -WhatIf too.
    if ($WhatIfPreference) {
        $actions.Add("dry run — skipped sync trigger + mailbox wait + regional/calendar (nothing was created)")
        Write-CtgStep "✓ dry run complete — would enable remote mailbox $($enableEmail), trigger a delta sync, then set regional/calendar (no changes made)"
        return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enableEmail; Routing = $enableRouting; Actions = $actions.ToArray() }
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
            Write-CtgStep "⚠ remote mailbox enabled ($($enableEmail)) but it hasn't synced to Exchange Online yet — regional/calendar deferred; run a directory sync, then re-run this step"
            return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enableEmail; Routing = $enableRouting; Actions = $actions.ToArray(); Warning = 'mailbox not synced before timeout — regional/calendar deferred to a re-run' }
        }
    }

    $regional = Set-CtgMailboxRegional -Identity $identity -Config $Config -ManagerEmail ([string](Get-CtgProp $User 'ManagerEmail'))
    if ($regional.Actions) { $actions.AddRange([string[]]$regional.Actions) }

    # Mirror the reference user's distribution lists + mail-enabled security groups (the EXO-managed
    # groups the Graph/m365 lane couldn't add). The mailbox now exists, so the new user is a valid
    # recipient. A failure here is non-fatal (the rest of the onboard already succeeded).
    # Explicitly-requested distribution lists (by name), then the reference-user mirror.
    $reqNames = @(Get-CtgRequestedGroupNames -Config $Config)   # @() — an empty function result collapses to $null otherwise
    if ($reqNames.Count -gt 0 -and $enableEmail) {
        try { foreach ($a in (Invoke-CtgExchangeNamedGroups -NewUser ([string]$enableEmail) -Groups $reqNames)) { $actions.Add($a) } }
        catch { $actions.Add("WARN requested distribution lists failed: $($_.Exception.Message)") }
    }
    $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
    if ($mirrorUser -and $enableEmail) {
        try { foreach ($a in (Invoke-CtgExchangeDistListMirror -MirrorUser ([string]$mirrorUser) -NewUser ([string]$enableEmail))) { $actions.Add($a) } }
        catch { $actions.Add("WARN distribution mirror failed: $($_.Exception.Message)") }
    }

    Write-CtgStep "✓ exchange onboard complete — mailbox $($enableEmail) live; $($actions -join '; ')"
    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Email = $enableEmail; Routing = $enableRouting; Actions = $actions.ToArray() }
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
    Write-CtgStep "offboard exchange: resolving target (UPN on case = '$([string](Get-CtgProp $User 'UserPrincipalName'))', display name = '$([string]((Get-CtgProp $User 'DisplayName') ?? (Get-CtgProp $User 'userToOffboard')))')"
    $resolved = Resolve-CtgExchangeTarget $User
    $upn = [string]$resolved.Upn
    if ($resolved.MatchCount -gt 1) {
        # SEVERAL recipients share this name. Never guess whose mailbox to convert — offer the shortlist.
        Write-CtgStep "$($resolved.MatchCount) recipients match '$($resolved.DisplayName)' — ambiguous, stopping"
        $actions.Add("WARN $($resolved.MatchCount) recipients match display name '$($resolved.DisplayName)' — pick the right one on the case. Nothing done.")
        return [pscustomobject]@{
            System = 'exchange'; Status = 'ok'; Upn = ''; MailboxSizeGB = 0
            Actions = $actions.ToArray()
            Candidates = @(Get-CtgExchangeOffboardCandidates -Name $resolved.DisplayName)
            CandidateQuery = [string]$resolved.DisplayName
            CandidateReason = 'ambiguous'
        }
    }
    # NO identifier at all on the case (not even a name to search on): we could not look the person up.
    # This used to return Status='ok' — a GREEN offboard step for a mailbox nobody touched. Fail loudly.
    if ([string]::IsNullOrWhiteSpace($upn) -and -not $resolved.DisplayName) {
        throw "exchange: the case carries no UPN, email or name for the user to offboard — set the offboard target on the case, then re-run."
    }
    if ([string]::IsNullOrWhiteSpace($upn)) {
        # The name on the ticket matches no recipient. Broaden and let a human choose rather than report
        # "nothing done" on a mailbox that is still live.
        Write-CtgStep "no exact recipient for '$($resolved.DisplayName)' — offering candidates"
        $cands = @(Get-CtgExchangeOffboardCandidates -Name $resolved.DisplayName)
        if ($cands.Count -gt 0) {
            $actions.Add("WARN no exact match for '$($resolved.DisplayName)' — $($cands.Count) similar recipient(s) found; pick the right one on the case. Nothing done.")
            return [pscustomobject]@{
                System = 'exchange'; Status = 'ok'; Upn = $upn; MailboxSizeGB = 0
                Actions = $actions.ToArray()
                Candidates = $cands
                CandidateQuery = [string]$resolved.DisplayName
                CandidateReason = 'no-match'
            }
        }
        $actions.Add("WARN no user identity on the case (no UPN, and no display-name match) — set the offboard target's email/UPN on the case, then re-run. Nothing done.")
        return [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Upn = $upn; MailboxSizeGB = 0; Actions = $actions.ToArray() }
    }
    if ($resolved.DisplayName) { $actions.Add("resolved offboard target by display name '$($resolved.DisplayName)' -> $upn"); Write-CtgStep "resolved '$($resolved.DisplayName)' -> '$upn'" }
    Write-CtgStep "running: Get-MailboxStatistics -Identity '$upn' (mailbox size)"
    $sizeGB = Get-CtgMailboxSizeGB -Identity $upn
    $actions.Add("mailbox size: $sizeGB GB")

    # Does the target have an EXO MAILBOX, or is it a MailUser (mailbox lives ON-PREM, EXO only holds a
    # mail-enabled pointer)? The EXO mailbox cmdlets below (Set-CASMailbox, Add/Get-MailboxPermission,
    # Set-MailboxAutoReplyConfiguration, Set-Mailbox forwarding) THROW on a MailUser ("This task does
    # not support recipients of this type"). For a MailUser we still do the on-prem shared conversion
    # (Set-RemoteMailbox, below) but skip the EXO-only steps with a note — they're managed on-prem.
    $hasExoMailbox = [bool](Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue)
    if (-not $hasExoMailbox) {
        $actions.Add("note: $upn is a MailUser in Exchange Online (mailbox is on-prem) — the shared conversion is done on-prem; EXO-only steps (Full Access delegate, ActiveSync/OWA, out-of-office, forwarding) don't apply here and are skipped")
        Write-CtgStep "target is a MailUser (on-prem mailbox) — doing the on-prem convert, skipping EXO-only mailbox steps"
    }

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
    if ($delegate -and -not $hasExoMailbox) {
        $actions.Add("Full Access delegate skipped — $upn is a MailUser (on-prem mailbox); grant Full Access on-prem if needed")
    }
    elseif ($delegate) {
        $mgr =
            if ($delegate -is [string]) { $delegate }
            elseif (Get-CtgProp $delegate 'address') { [string](Get-CtgProp $delegate 'address') }
            else { [string]((Get-CtgProp $User 'ManagerEmail') ?? (Get-CtgProp $User 'ManagerUpn') ?? (Get-CtgProp $User 'Manager')) }
        # A manager given as a NAME, not an address — resolve it to a mailbox before granting anything.
        if ($mgr -and $mgr -notmatch '@') {
            $named = $mgr
            $mgr = Resolve-CtgAddressByDisplayName -Name $named
            if ($mgr) { $actions.Add("resolved manager '$named' -> $mgr") }
            else { $actions.Add("WARN could not resolve manager '$named' to a mailbox (no single match) — Full Access delegate skipped") }
        }
        # The intake's OWN manager field: ServiceNow carries `managerName` (a display name). Reading it
        # here is what makes the delegate work on a case whose directory link is already gone (the AD
        # offboard step clears it) — the form named the person all along.
        if (-not $mgr) {
            $named = [string](Get-CtgProp $User 'managerName')
            if ($named) {
                Write-CtgStep "the case names manager '$named' — resolving to a mailbox"
                $mgr = Resolve-CtgAddressByDisplayName -Name $named
                if ($mgr) { $actions.Add("resolved manager '$named' from the case -> $mgr") }
                else { $actions.Add("WARN the case names manager '$named' but no single matching mailbox was found") }
            }
        }
        # Last resort — the DIRECTORY link: Entra/Graph first (the authoritative cloud manager link),
        # then Exchange, then on-prem AD. Resolved to a primary SMTP.
        if (-not $mgr) {
            Write-CtgStep "no manager on the case — looking it up in the directory (Entra/Exchange/AD) for '$upn'"
            $mgr = Resolve-CtgManagerAddress -Upn $upn
            if ($mgr) {
                $actions.Add("resolved manager from the directory: $mgr")
                Write-CtgStep "resolved manager -> $mgr"
            }
        }
        if (-not $mgr) {
            $actions.Add("WARN delegateManagerFullAccess set but no manager on the case OR in the directory (Entra/Exchange/AD) — Full Access delegate skipped")
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
    if ($message -and $hasExoMailbox -and $PSCmdlet.ShouldProcess($upn, "Set out-of-office")) {
        Set-MailboxAutoReplyConfiguration -Identity $upn -AutoReplyState Enabled -InternalMessage $message -ExternalMessage $message
        $actions.Add("set out-of-office reply")
    }

    # 3. On-request forwarding ------------------------------------------------
    $forwarding = Get-CtgProp $Config 'forwarding'
    $fwdAddr = if ($forwarding) { Get-CtgProp $forwarding 'address' } else { $null }
    if ($fwdAddr -and $hasExoMailbox -and $PSCmdlet.ShouldProcess($upn, "Forward to $fwdAddr")) {
        $keepCopy = [bool](Get-CtgProp $forwarding 'keepCopy')
        Set-Mailbox -Identity $upn -ForwardingSmtpAddress $fwdAddr -DeliverToMailboxAndForward:$keepCopy
        $actions.Add("forwarding to $fwdAddr (keep copy: $keepCopy)")
    }

    # 4. Block mobile devices / OWA ------------------------------------------
    if ((Get-CtgProp $Config 'blockMobileDevices') -ne $false -and $hasExoMailbox) {
        if ($PSCmdlet.ShouldProcess($upn, "Disable ActiveSync + OWA")) {
            Set-CASMailbox -Identity $upn -ActiveSyncEnabled $false -OWAEnabled $false
            $actions.Add("disabled ActiveSync and OWA")
        }
    }

    # 5. Remove from CLOUD distribution lists / mail-enabled groups (Graph can't change these; the
    # Entra step routed them here). Only IsDirSynced=$false ones — on-prem-synced DLs are removed by
    # the AD step. Config removeDistributionGroups (default on). Scans the DLs the user belongs to.
    if ((Get-CtgProp $Config 'removeDistributionGroups') -ne $false) {
        Write-CtgStep "scanning cloud distribution lists for '$upn' memberships…"
        $dls = @(Get-DistributionGroup -ResultSize Unlimited -ErrorAction SilentlyContinue | Where-Object { -not (Get-CtgProp $_ 'IsDirSynced') })
        $checked = 0; $removed = 0
        foreach ($dl in $dls) {
            $checked++
            $members = @(Get-DistributionGroupMember -Identity $dl.Identity -ResultSize Unlimited -ErrorAction SilentlyContinue)
            $isMember = @($members | ForEach-Object { [string](Get-CtgProp $_ 'PrimarySmtpAddress') }) -contains $upn
            if (-not $isMember) { continue }
            if ($PSCmdlet.ShouldProcess($dl.DisplayName, "Remove $upn from distribution list")) {
                try {
                    Remove-DistributionGroupMember -Identity $dl.Identity -Member $upn -BypassSecurityGroupManagerCheck -Confirm:$false -ErrorAction Stop
                    $actions.Add("removed from cloud distribution list: $($dl.DisplayName)")
                    $removed++
                }
                catch { $actions.Add("WARN could not remove from DL $($dl.DisplayName): $($_.Exception.Message)") }
            }
        }
        $actions.Add("scanned $checked cloud distribution list(s); removed from $removed")
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

    # Resolve the SAME way the executor does, or the read-back checks the wrong identity and always
    # "misses" — which would re-run the offboard repeatedly via the idempotent revalidate loop.
    $upn = [string](Resolve-CtgExchangeTarget $User).Upn
    if ([string]::IsNullOrWhiteSpace($upn)) {
        # Couldn't resolve a unique target (the executor already warned + did nothing) — nothing to
        # verify, so pass rather than fail-and-retry forever.
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'no resolvable offboard target — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }
    $mbx = Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue
    $cts = Get-CtgProp $Config 'convertToShared'
    if ($cts) {
        $threshold = [double]((Get-CtgProp $cts 'skipIfMailboxOverGB') ?? 50)
        $sizeGB = Get-CtgMailboxSizeGB -Identity $upn
        if ($sizeGB -gt $threshold) {
            & $add "mailbox kept (>$threshold GB)" $true $true   # over-threshold mailboxes are intentionally not converted
        }
        else {
            # HYBRID timing: the conversion is done on-prem (Set-RemoteMailbox -Type Shared) and flows to
            # EXO on the next Entra Connect sync — so Get-Mailbox (EXO) can still read UserMailbox for a
            # while after a successful convert. The on-prem RemoteMailbox reflects it IMMEDIATELY, so treat
            # the mailbox as shared when EITHER EXO shows SharedMailbox OR the on-prem remote mailbox shows
            # a shared type (RemoteSharedMailbox). Otherwise the read-back false-fails and the case
            # re-runs the offboard in a loop until the sync lands.
            $exoType = [string](Get-CtgProp $mbx 'RecipientTypeDetails')
            $remote = if (Get-Command Get-RemoteMailbox -ErrorAction SilentlyContinue) { Get-RemoteMailbox -Identity $upn -ErrorAction SilentlyContinue } else { $null }
            $remoteType = [string](Get-CtgProp $remote 'RecipientTypeDetails')
            $isShared = ($exoType -eq 'SharedMailbox') -or ($remoteType -match 'Shared')
            $actual = if ($isShared) { 'SharedMailbox' } elseif ($exoType) { "$exoType$(if ($remoteType) { " (on-prem remote: $remoteType — EXO reflects it after the next sync)" })" } else { $remoteType }
            & $add 'mailbox is shared' 'SharedMailbox' $actual
        }
    }
    # ActiveSync/OWA live on the EXO mailbox — a MailUser (on-prem mailbox) has none, and the executor
    # skips disabling them in EXO, so don't verify them here either (Get-CASMailbox would error/miss).
    if ((Get-CtgProp $Config 'blockMobileDevices') -ne $false -and $mbx) {
        $cas = Get-CASMailbox -Identity $upn -ErrorAction SilentlyContinue
        & $add 'ActiveSync disabled' $false ([bool](Get-CtgProp $cas 'ActiveSyncEnabled'))
        & $add 'OWA disabled' $false ([bool](Get-CtgProp $cas 'OWAEnabled'))
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgExchange, Connect-CtgExchangeOnPrem, Get-CtgMailboxSizeGB, Invoke-CtgExchangeOnboarding, Invoke-CtgExchangeHybridOnboard, Invoke-CtgExchangeCloudOnboard, Invoke-CtgExchangeNamedGroups, Invoke-CtgExchangeDistListMirror, Invoke-CtgExchangeSharedMailboxMirror, Set-CtgMailboxRegional, Wait-CtgMailbox, Invoke-CtgExchangeOffboarding, Confirm-CtgExchange
