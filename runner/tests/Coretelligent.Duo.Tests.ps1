#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Duo. Mocks the HTTP seam (Invoke-CtgDuoApi). Behaviour pinned:
# offboard DEACTIVATES by default (status=disabled), DELETES only when config.delete; idempotent;
# clean no-op when the user is absent. Plus a pure signature test (HMAC is deterministic).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Duo/Coretelligent.Duo.psm1" -Force
}

Describe 'Get-CtgDuoSignature' {
    It 'produces a stable lowercase hex HMAC-SHA1 over the canonical string' {
        $sig = Get-CtgDuoSignature -Date 'Tue, 01 Jan 2030 00:00:00 -0000' -Method 'GET' -DuoHost 'api-abc.duosecurity.com' -Path '/admin/v1/users' -Params @{ username = 'jdoe@x.com' } -SecretKey 'topsecret'
        $sig | Should -Match '^[0-9a-f]{40}$'
        # Determinism: same inputs -> same signature.
        $sig2 = Get-CtgDuoSignature -Date 'Tue, 01 Jan 2030 00:00:00 -0000' -Method 'GET' -DuoHost 'api-abc.duosecurity.com' -Path '/admin/v1/users' -Params @{ username = 'jdoe@x.com' } -SecretKey 'topsecret'
        $sig | Should -Be $sig2
    }
}

Describe 'Invoke-CtgDuoOffboarding' {
    It 'disables the user by default (status=disabled)' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith {
            param($Method, $Path, $Params)
            if ($Method -eq 'GET') { return [pscustomobject]@{ response = @([pscustomobject]@{ user_id = 'u1'; username = 'jdoe@x.com'; status = 'active' }) } }
            return [pscustomobject]@{ response = @{} }
        }
        $r = Invoke-CtgDuoOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/admin/v1/users/u1' -and $Params.status -eq 'disabled' } -Times 1
        Should -Invoke Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'disabled Duo user'
    }

    It 'deletes only when config.delete is set' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith {
            param($Method, $Path, $Params)
            if ($Method -eq 'GET') { return [pscustomobject]@{ response = @([pscustomobject]@{ user_id = 'u1'; username = 'jdoe@x.com'; status = 'active' }) } }
            return $null
        }
        $r = Invoke-CtgDuoOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ delete = $true })
        Should -Invoke Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/admin/v1/users/u1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'deleted Duo user'
    }

    It 'is idempotent — no change when already disabled' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith {
            param($Method, $Path, $Params)
            if ($Method -eq 'GET') { return [pscustomobject]@{ response = @([pscustomobject]@{ user_id = 'u1'; username = 'jdoe@x.com'; status = 'disabled' }) } }
            return $null
        }
        $r = Invoke-CtgDuoOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already disabled'
    }

    It 'is a no-op when the user is not in Duo' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith {
            param($Method, $Path, $Params)
            if ($Method -eq 'GET') { return [pscustomobject]@{ response = @() } }
            return $null
        }
        $r = Invoke-CtgDuoOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgDuo' {
    It 'offboard: passes when the user is disabled' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith { [pscustomobject]@{ response = @([pscustomobject]@{ user_id = 'u1'; username = 'jdoe@x.com'; status = 'disabled' }) } }
        (Confirm-CtgDuo -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }

    It 'offboard: passes when the user is absent' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith { [pscustomobject]@{ response = @() } }
        (Confirm-CtgDuo -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }

    It 'offboard: fails when the user is still active' {
        Mock Invoke-CtgDuoApi -ModuleName Coretelligent.Duo -MockWith { [pscustomobject]@{ response = @([pscustomobject]@{ user_id = 'u1'; username = 'jdoe@x.com'; status = 'active' }) } }
        (Confirm-CtgDuo -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeFalse
    }
}
