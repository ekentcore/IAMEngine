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

# Auto-discover the Entra Connect server from AD — no hard-coding. Azure AD Connect creates a sync
# account (legacy MSOL_*, newer AAD_*) whose Description records the install host:
# "...running on computer <NAME> configured to synchronize to tenant...". We read that and return an
# FQDN. Needs the ActiveDirectory module (present on the DC agent) + a credential to read AD.
function Find-CtgADSyncHost {
    [CmdletBinding()]
    param([pscredential]$Credential)
    if (-not (Get-Command Get-ADUser -ErrorAction SilentlyContinue)) {
        try { Import-Module ActiveDirectory -ErrorAction Stop } catch { return $null }
    }
    $p = @{ Filter = "samAccountName -like 'MSOL_*' -or samAccountName -like 'AAD_*'"; Properties = 'Description'; ErrorAction = 'Stop' }
    if ($Credential) { $p.Credential = $Credential }
    try { $accts = @(Get-ADUser @p) } catch { return $null }
    foreach ($a in $accts) {
        if ($a.Description -and $a.Description -match 'running on computer (\S+)') {
            $name = $matches[1].TrimEnd('.', ',')
            if ($name -notmatch '\.') {
                $domP = @{ ErrorAction = 'SilentlyContinue' }; if ($Credential) { $domP.Credential = $Credential }
                $dom = (Get-ADDomain @domP).DNSRoot
                if ($dom) { $name = "$name.$dom" }
            }
            return $name
        }
    }
    return $null
}

# Resolve whether to run ADSync locally or remote into the Entra Connect host. Returns
# @{ Remote; Host; Discovered }. Local when ADSync is installed here. Otherwise (Model A: one DC
# runner) remote into the host — taken from config.host if set, else auto-discovered from AD.
function Resolve-CtgADSyncTarget {
    param([string]$SyncHost, [pscredential]$Credential)
    if (Initialize-CtgADSync) { return @{ Remote = $false; Host = $null; Discovered = $false } }
    $discovered = $false
    $h = $SyncHost
    if (-not $h) { $h = Find-CtgADSyncHost -Credential $Credential; if ($h) { $discovered = $true } }
    if (-not $h) {
        throw "the ADSync module (Azure AD Connect) isn't installed on this host, and the Entra Connect server couldn't be auto-discovered from AD. Set the directory-sync 'host' explicitly, or make sure the MSOL_/AAD_ sync account is readable."
    }
    if (-not $Credential) {
        throw "remoting to the Entra Connect host '$h' needs a credential — add the ad-dc secret to the directory-sync step so it's brokered (and that account must be allowed to run ADSync on $h)."
    }
    return @{ Remote = $true; Host = $h; Discovered = $discovered }
}

function Invoke-CtgDirectorySync {
    <#
    .SYNOPSIS
        Start an Azure AD Connect delta sync, unless one is already running. Runs where the ADSync
        module lives: locally if installed, else remoted (WinRM) into the configured Entra Connect host.
    .PARAMETER Config
        { host } — the Entra Connect server (e.g. "Core-CCE-AzSync"). Used to remote when ADSync
        isn't on this agent's host.
    .PARAMETER Credential
        Domain credential (ad-dc) used to remote into the host; must be in ADSyncOperators there.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([pscustomobject]$Config, [pscredential]$Credential)

    $actions = [System.Collections.Generic.List[string]]::new()
    $syncHost = Get-CtgProp $Config 'host'
    $target = Resolve-CtgADSyncTarget -SyncHost $syncHost -Credential $Credential
    if ($target.Remote) { $actions.Add("remoting into Entra Connect host: $($target.Host)$(if ($target.Discovered) { ' (auto-discovered from AD)' })") }

    if ($WhatIfPreference) {
        $actions.Add("dry run — would Start-ADSyncSyncCycle -PolicyType Delta$(if ($target.Remote) { " on $($target.Host)" } else { ' locally' })")
        return [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
    }

    # Self-contained for remoting (the target imports ADSync itself); local path calls the cmdlets
    # directly so unit-test mocks of Get-ADSyncScheduler/Start-ADSyncSyncCycle still apply.
    $remoteScript = {
        Import-Module ADSync -ErrorAction Stop
        if ((Get-ADSyncScheduler).SyncCycleInProgress) { 'in-progress' }
        else { Start-ADSyncSyncCycle -PolicyType Delta | Out-Null; 'started' }
    }
    $outcome =
        if ($target.Remote) { Invoke-Command -ComputerName $target.Host -Credential $Credential -ScriptBlock $remoteScript -ErrorAction Stop }
        elseif ((Get-ADSyncScheduler).SyncCycleInProgress) { 'in-progress' }
        else { Start-ADSyncSyncCycle -PolicyType Delta | Out-Null; 'started' }

    if ($outcome -eq 'in-progress') {
        $actions.Add("a sync cycle is already in progress — skipped (the pending change will be picked up)")
    } else {
        $actions.Add("started delta sync (Start-ADSyncSyncCycle -PolicyType Delta)")
    }
    [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Confirm-CtgDirectorySync {
    <#
    .SYNOPSIS
        Post-action read-back for Azure AD Connect: the sync scheduler is healthy (enabled). A cycle
        that's IN PROGRESS is success, not a miss — we just triggered it. No mutations; { ok; checks }.
    #>
    [CmdletBinding()]
    param(
        [pscustomobject]$User,
        [pscustomobject]$Config,
        [ValidateSet('onboard', 'offboard')][string]$Action,
        [pscredential]$Credential
    )
    $syncHost = Get-CtgProp $Config 'host'
    # Return scheduler health, not just in-progress. Enabled = the sync mechanism is working; a cycle
    # in progress right after we triggered one is the expected, healthy state.
    $remoteScript = { Import-Module ADSync -ErrorAction Stop; $s = Get-ADSyncScheduler; @{ Enabled = [bool]$s.SyncCycleEnabled; InProgress = [bool]$s.SyncCycleInProgress } }
    try {
        $target = Resolve-CtgADSyncTarget -SyncHost $syncHost -Credential $Credential
        $state =
            if ($target.Remote) { Invoke-Command -ComputerName $target.Host -Credential $Credential -ScriptBlock $remoteScript -ErrorAction Stop }
            else { $s = Get-ADSyncScheduler; @{ Enabled = [bool]$s.SyncCycleEnabled; InProgress = [bool]$s.SyncCycleInProgress } }
    } catch {
        return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'ADSync reachable'; expected = $true; actual = $false; pass = $false }) }
    }
    $enabled = [bool]$state.Enabled
    $checks = @(
        @{ name = 'Entra Connect sync scheduler enabled'; expected = $true; actual = $enabled; pass = $enabled },
        @{ name = 'sync cycle running (informational)'; expected = $null; actual = [bool]$state.InProgress; pass = $true }
    )
    [pscustomobject]@{ ok = $enabled; checks = $checks }
}

Export-ModuleMember -Function Invoke-CtgDirectorySync, Confirm-CtgDirectorySync
