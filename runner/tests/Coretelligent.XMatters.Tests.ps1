#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.XMatters. Mocks the HTTP seam (Invoke-CtgXMattersApi). Behaviour
# pinned: offboard DEACTIVATES by default (status=INACTIVE), DELETES only when config.delete;
# idempotent; clean no-op when the person is absent.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.XMatters/Coretelligent.XMatters.psm1" -Force
}

Describe 'Invoke-CtgXMattersOffboarding' {
    It 'deactivates the person by default (status=INACTIVE)' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ count = 1; data = @([pscustomobject]@{ id = 'p1'; targetName = 'jdoe@x.com'; status = 'ACTIVE' }) } }
            return [pscustomobject]@{ id = 'p1' }
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/people' -and $Body.status -eq 'INACTIVE' -and $Body.id -eq 'p1' } -Times 1
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'deactivated xMatters'
    }

    It 'deletes only when config.delete is set' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'p1'; targetName = 'jdoe@x.com'; status = 'ACTIVE' }) } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ delete = $true })
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/people/p1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'deleted xMatters'
    }

    It 'is idempotent — no change when already inactive' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'p1'; targetName = 'jdoe@x.com'; status = 'INACTIVE' }) } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already inactive'
    }

    It 'is a no-op when the person is not in xMatters' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ count = 0; data = @() } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgXMatters' {
    It 'offboard: passes when inactive' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ data = @([pscustomobject]@{ id = 'p1'; targetName = 'jdoe@x.com'; status = 'INACTIVE' }) } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: passes when absent' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ data = @() } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: fails when still active' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ data = @([pscustomobject]@{ id = 'p1'; targetName = 'jdoe@x.com'; status = 'ACTIVE' }) } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeFalse
    }
}
