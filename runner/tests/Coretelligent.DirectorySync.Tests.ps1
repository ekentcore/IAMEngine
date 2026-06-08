#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.DirectorySync. The ADSync cmdlets ship with Azure AD Connect
# (not a gallery module), so we stub + mock them. Behaviour: trigger a delta sync, but skip
# (idempotent) if a sync cycle is already running.

BeforeAll {
    function global:Get-ADSyncScheduler {}
    function global:Start-ADSyncSyncCycle { [CmdletBinding()] param([string]$PolicyType) }
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

    It 'throws a clear error when ADSync is not local and no host is configured' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) } | Should -Throw -ExpectedMessage '*host*'
    }

    It 'throws when remoting is needed but no credential was brokered' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) } | Should -Throw -ExpectedMessage '*credential*'
    }
}

Describe 'Confirm-CtgDirectorySync' {
    It 'passes when no sync cycle is in progress (settled)' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'fails while a sync cycle is still running' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $true } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}
