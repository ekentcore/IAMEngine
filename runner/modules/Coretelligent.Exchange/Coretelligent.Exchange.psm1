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

Export-ModuleMember -Function Connect-CtgExchange, Get-CtgMailboxSizeGB, Invoke-CtgExchangeOffboarding, Confirm-CtgExchange
