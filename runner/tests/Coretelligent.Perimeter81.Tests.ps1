#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Perimeter81. Mocks the HTTP seam (Invoke-CtgP81Api). NOTE: there
# is no authoritative public/Context7 API reference for Perimeter 81 / Check Point Harmony SASE,
# so the endpoints are best-effort and must be verified on the tenant. The BEHAVIOUR is the
# contract these tests pin: onboarding is group-driven (never adds the user directly);
# offboarding finds and removes the user.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Perimeter81/Coretelligent.Perimeter81.psm1" -Force
}

Describe 'Invoke-CtgPerimeter81Onboarding' {
    It 'is group-driven: it never adds the user directly' {
        Mock Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -MockWith { [pscustomobject]@{ data = @() } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $config = [pscustomobject]@{ note = 'Do not add the user (group-driven).' }
        $r = Invoke-CtgPerimeter81Onboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        # no create/add user calls (POST to /users)
        Should -Invoke Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -ParameterFilter { $Method -eq 'POST' -and $Path -match '/users' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'group-driven'
    }
}

Describe 'Invoke-CtgPerimeter81Offboarding' {
    It 'finds the user by email and removes them' {
        Mock Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'p81-1'; email = 'jdoe@61commodities.com' }) } }
            return $null
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $config = [pscustomobject]@{ removeUser = $true; downtickLicense = $true }
        $r = Invoke-CtgPerimeter81Offboarding -User $user -Config $config
        Should -Invoke Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -ParameterFilter { $Method -eq 'DELETE' -and $Path -match 'p81-1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'removed'
    }

    It 'is idempotent — no-op when the user is not found' {
        Mock Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -MockWith { [pscustomobject]@{ data = @() } }
        $user = [pscustomobject]@{ UserPrincipalName = 'gone@61commodities.com' }
        $r = Invoke-CtgPerimeter81Offboarding -User $user -Config ([pscustomobject]@{ removeUser = $true })
        Should -Invoke Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgPerimeter81' {
    It 'offboard: passes when the user is absent (seat freed)' {
        Mock Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -MockWith { [pscustomobject]@{ data = @() } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgPerimeter81 -User $user -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: passes when license headroom is available' {
        Mock Invoke-CtgP81Api -ModuleName Coretelligent.Perimeter81 -MockWith {
            param($Method, $Path, $Body)
            return [pscustomobject]@{ available = 5 }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgPerimeter81 -User $user -Config ([pscustomobject]@{ ensureLicenseAvailable = $true }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }
}
