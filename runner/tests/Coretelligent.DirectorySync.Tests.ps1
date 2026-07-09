#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.DirectorySync. The ADSync cmdlets ship with Azure AD Connect
# (not a gallery module), so we stub + mock them. Behaviour: trigger a delta sync, but skip
# (idempotent) if a sync cycle is already running.

BeforeAll {
    function global:Get-ADSyncScheduler {}
    function global:Start-ADSyncSyncCycle { [CmdletBinding()] param([string]$PolicyType) }
    function global:Get-ADUser { param($Filter, $Properties, $Credential) }
    function global:Get-ADDomain { param($Credential) }
    Import-Module "$PSScriptRoot/../modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psm1" -Force
}

Describe 'Invoke-CtgDirectorySync' {
    It 'starts a delta sync when none is in progress' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync
        $r.Status | Should -Be 'ok'
        Should -Invoke Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $PolicyType -eq 'Delta' }
        ($r.Actions -join ' ') | Should -Match 'started delta sync'
    }

    It 'skips (idempotent) when a sync cycle is already running' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $true } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync
        Should -Invoke Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already in progress'
    }
}

Describe 'Invoke-CtgDirectorySync remoting (Model A)' {
    It 'remotes into the configured host when ADSync is not installed locally' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { 'started' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) -Credential $cred
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-Command -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $ComputerName -eq 'Core-CCE-AzSync' }
        ($r.Actions -join ' ') | Should -Match 'remoting into Entra Connect host'
    }

    It 'auto-discovers the Entra Connect host from the sync account when no host is configured' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Get-ADUser -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ Description = 'Account created by Microsoft Entra Connect ... running on computer CORE-CCE-AZSYNC configured to synchronize to tenant coretell.onmicrosoft.com.' } }
        Mock Get-ADDomain -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ DNSRoot = 'coretelligent.local' } }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { 'started' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) -Credential $cred
        Should -Invoke Invoke-Command -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $ComputerName -eq 'CORE-CCE-AZSYNC.coretelligent.local' }
        ($r.Actions -join ' ') | Should -Match 'auto-discovered from AD'
    }

    It 'throws a clear error when ADSync is not local and the host cannot be determined' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Get-ADUser -ModuleName Coretelligent.DirectorySync -MockWith { @() }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) } | Should -Throw -ExpectedMessage '*host*'
    }

    It 'throws when remoting is needed but no credential was brokered' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) } | Should -Throw -ExpectedMessage '*credential*'
    }

    It 'surfaces a real remote failure — the pwsh7->5.1 fallback must not swallow a non-System.Web error' {
        # A genuine auth/connectivity error (not the .NET Core System.Web assembly gap) must propagate,
        # not be masked by the fallback. On the non-Windows test host the fallback is never attempted, so
        # the error surfaces directly — which is exactly the behaviour we want to lock.
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { throw 'Access is denied' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) -Credential $cred } | Should -Throw -ExpectedMessage '*Access is denied*'
    }
}

Describe 'Confirm-CtgDirectorySync' {
    It 'passes when the scheduler is enabled and a cycle is settled' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $true; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'still passes while a cycle is in progress (we just triggered it — not a miss)' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $true; SyncCycleInProgress = $true } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'fails when the sync scheduler is disabled' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $false; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}
