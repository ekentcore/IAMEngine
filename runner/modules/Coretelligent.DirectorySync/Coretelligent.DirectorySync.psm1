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

Export-ModuleMember -Function Invoke-CtgDirectorySync
