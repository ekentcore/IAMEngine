#Requires -Version 7.0

# Coretelligent.DirectorySync
# Triggers an Azure AD Connect delta sync so an on-prem AD change (create/disable/group) flows
# up to Entra/365. Runs after `active-directory` on BOTH lanes for ad-synced clients. The
# ADSync cmdlets ship with Azure AD Connect and run on (or are remoted to) the AAD Connect host.
# Idempotent: never starts a second cycle while one is in progress.

Set-StrictMode -Version Latest

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Make the ADSync cmdlets available. They ship with Azure AD Connect but aren't on the default
# PSModulePath, and the module is a Windows PowerShell module — under PowerShell 7 it needs the
# compatibility shim. Try by name, then the WinPS compat load, then the standard install path.
# Returns $true if Get-ADSyncScheduler is callable afterward. Throws a clear, host-pointed error at
# the call sites when it can't be loaded (i.e. Azure AD Connect isn't installed on this host).
function Initialize-CtgADSync {
    if (Get-Command Get-ADSyncScheduler -ErrorAction SilentlyContinue) { return $true }
    $attempts = @(
        { Import-Module ADSync -ErrorAction Stop },
        { Import-Module ADSync -UseWindowsPowerShell -ErrorAction Stop },
        { Import-Module "$env:ProgramFiles\Microsoft Azure AD Sync\Bin\ADSync\ADSync.psd1" -ErrorAction Stop }
    )
    foreach ($a in $attempts) {
        try { & $a } catch { }
        if (Get-Command Get-ADSyncScheduler -ErrorAction SilentlyContinue) { return $true }
    }
    return $false
}

function Invoke-CtgDirectorySync {
    <#
    .SYNOPSIS
        Start an Azure AD Connect delta sync, unless one is already running.
    .PARAMETER Config
        Optional: { host } — the AAD Connect host (e.g. "61c-dc01"). When the agent isn't on
        that host, the runner remotes this module to it; the host is informational here.
    .OUTPUTS
        Result object with Status and an Actions log.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $syncHost = Get-CtgProp $Config 'host'
    if ($syncHost) { $actions.Add("AAD Connect host: $syncHost") }

    if (-not (Initialize-CtgADSync)) {
        throw "the ADSync module (Azure AD Connect) isn't available on this host$(if ($syncHost) { " — Azure AD Connect is expected on '$syncHost'" }). Run the directory-sync step on the Azure AD Connect server (enroll an agent there), or trigger the sync manually with Start-ADSyncSyncCycle -PolicyType Delta."
    }

    $scheduler = Get-ADSyncScheduler
    if ($scheduler.SyncCycleInProgress) {
        $actions.Add("a sync cycle is already in progress — skipped (the pending change will be picked up)")
        return [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
    }

    if ($PSCmdlet.ShouldProcess('Azure AD Connect', 'Start delta sync')) {
        Start-ADSyncSyncCycle -PolicyType Delta | Out-Null
        $actions.Add("started delta sync (Start-ADSyncSyncCycle -PolicyType Delta)")
    }

    [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Confirm-CtgDirectorySync {
    <#
    .SYNOPSIS
        Post-action read-back for Azure AD Connect: the delta sync has settled (no cycle in
        progress). No mutations; returns { ok; checks[] }. Same check for both lanes.
    #>
    [CmdletBinding()]
    param(
        [pscustomobject]$User,
        [pscustomobject]$Config,
        [ValidateSet('onboard', 'offboard')][string]$Action
    )
    if (-not (Initialize-CtgADSync)) {
        return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'ADSync module available'; expected = $true; actual = $false; pass = $false }) }
    }
    $scheduler = Get-ADSyncScheduler
    $inProgress = [bool](Get-CtgProp $scheduler 'SyncCycleInProgress')
    $check = @{ name = 'delta sync settled'; expected = $false; actual = $inProgress; pass = (-not $inProgress) }
    [pscustomobject]@{ ok = $check.pass; checks = @($check) }
}

Export-ModuleMember -Function Invoke-CtgDirectorySync, Confirm-CtgDirectorySync
