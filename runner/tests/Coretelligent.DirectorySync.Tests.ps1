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
