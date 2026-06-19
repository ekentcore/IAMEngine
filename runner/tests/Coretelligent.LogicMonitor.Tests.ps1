#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.LogicMonitor. Mocks the HTTP seam (Invoke-CtgLogicMonitorApi).
# Behaviour pinned: offboard SUSPENDS by default, DELETES only when config.delete; idempotent;
# clean no-op when absent. Plus a pure LMv1 signature test.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.LogicMonitor/Coretelligent.LogicMonitor.psm1" -Force
}

Describe 'Get-CtgLmSignature' {
    It 'produces a stable base64 LMv1 signature' {
        $sig = Get-CtgLmSignature -Method 'GET' -Epoch '1700000000000' -Body '' -ResourcePath '/setting/admins' -AccessKey 'topsecret'
        $sig | Should -Match '^[A-Za-z0-9+/]+={0,2}$'
        (Get-CtgLmSignature -Method 'GET' -Epoch '1700000000000' -Body '' -ResourcePath '/setting/admins' -AccessKey 'topsecret') | Should -Be $sig
    }
}

Describe 'Invoke-CtgLogicMonitorOffboarding' {
    It 'suspends the user by default (status=suspended)' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = [pscustomobject]@{ total = 1; items = @([pscustomobject]@{ id = 7; email = 'jdoe@x.com'; status = 'active' }) } } }
            return [pscustomobject]@{ data = @{} }
        }
        $r = Invoke-CtgLogicMonitorOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -ParameterFilter { $Method -eq 'PATCH' -and $Path -eq '/setting/admins/7' -and $Body.status -eq 'suspended' } -Times 1
        Should -Invoke Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'suspended LogicMonitor'
    }

    It 'deletes only when config.delete is set' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = [pscustomobject]@{ items = @([pscustomobject]@{ id = 7; email = 'jdoe@x.com'; status = 'active' }) } } }
            return $null
        }
        $r = Invoke-CtgLogicMonitorOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ delete = $true })
        Should -Invoke Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/setting/admins/7' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'deleted LogicMonitor'
    }

    It 'is idempotent — no change when already suspended' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = [pscustomobject]@{ items = @([pscustomobject]@{ id = 7; email = 'jdoe@x.com'; status = 'suspended' }) } } }
            return $null
        }
        $r = Invoke-CtgLogicMonitorOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already suspended'
    }

    It 'is a no-op when the user is not in LogicMonitor' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = [pscustomobject]@{ total = 0; items = @() } } }
            return $null
        }
        $r = Invoke-CtgLogicMonitorOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgLogicMonitor' {
    It 'offboard: passes when suspended' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith { [pscustomobject]@{ data = [pscustomobject]@{ items = @([pscustomobject]@{ id = 7; email = 'jdoe@x.com'; status = 'suspended' }) } } }
        (Confirm-CtgLogicMonitor -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: passes when absent' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith { [pscustomobject]@{ data = [pscustomobject]@{ items = @() } } }
        (Confirm-CtgLogicMonitor -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: fails when still active' {
        Mock Invoke-CtgLogicMonitorApi -ModuleName Coretelligent.LogicMonitor -MockWith { [pscustomobject]@{ data = [pscustomobject]@{ items = @([pscustomobject]@{ id = 7; email = 'jdoe@x.com'; status = 'active' }) } } }
        (Confirm-CtgLogicMonitor -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeFalse
    }
}
