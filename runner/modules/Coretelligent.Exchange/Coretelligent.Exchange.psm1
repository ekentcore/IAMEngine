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
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Organization,
        [Parameter(Mandatory)][string]$CertificateThumbprint
    )
    Connect-ExchangeOnline -AppId $AppId -Organization $Organization -CertificateThumbprint $CertificateThumbprint -ShowBanner:$false
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
    .OUTPUTS
        Result with Status, MailboxSizeGB (so the m365 module can honor the keep-license rule),
        and an Actions log.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = $User.UserPrincipalName
    $sizeGB = Get-CtgMailboxSizeGB -Identity $upn
    $actions.Add("mailbox size: $sizeGB GB")

    # 1. Convert to shared — unless over the threshold ------------------------
    $cts = Get-CtgProp $Config 'convertToShared'
    if ($cts) {
        $threshold = [double]((Get-CtgProp $cts 'skipIfMailboxOverGB') ?? 50)
        if ($sizeGB -gt $threshold) {
            $actions.Add("mailbox $sizeGB GB over threshold ($threshold GB) — kept as a user mailbox; license stays")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Convert mailbox to shared")) {
            Set-Mailbox -Identity $upn -Type Shared
            $actions.Add("converted mailbox to shared")
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

Export-ModuleMember -Function Connect-CtgExchange, Connect-CtgExchangeOnPrem, Get-CtgMailboxSizeGB, Invoke-CtgExchangeOnboarding, Invoke-CtgExchangeHybridOnboard, Set-CtgMailboxRegional, Wait-CtgMailbox, Invoke-CtgExchangeOffboarding, Confirm-CtgExchange
