#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.GoogleWorkspace. Mocks the HTTP seam (Invoke-CtgGoogleApi).
# Admin SDK Directory API: create POST /users; OU/suspend PUT /users/{email}; groups via
# /groups?userKey=. Offboard SUSPENDS (never deletes) and captures group evidence first.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1" -Force
    # The runner generates the password (New-CtgCompliantPassword, in Coretelligent.M365) and passes
    # it in via -InitialPassword, so the module is testable alone with a literal.
    $script:TestPassword = ConvertTo-SecureString 'P@ssw0rd-Test!' -AsPlainText -Force
}

Describe 'Invoke-CtgGoogleOnboarding' {
    BeforeEach { $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com'; FirstName = 'Jane'; LastName = 'Doe' } }

    It 'creates a user in the target OU when none exists' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return $null }   # user not found
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return $null }   # no groups
            return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' }
        }
        $r = Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users'; groups = @('staff@brightonpark.com') }) -InitialPassword $script:TestPassword
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 1
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/groups/staff@brightonpark.com/members' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Google user'
    }

    It 'is idempotent — skips create when the user already exists' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return [pscustomobject]@{ groups = @([pscustomobject]@{ email = 'staff@brightonpark.com' }) } }
            return $null
        }
        $r = Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users'; groups = @('staff@brightonpark.com') }) -InitialPassword $script:TestPassword
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already in group'
    }

    It 'refuses to place a user in the Root OU' {
        { Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/' }) -InitialPassword $script:TestPassword } | Should -Throw
    }
}

Describe 'Invoke-CtgGoogleOffboarding' {
    It 'captures group evidence, suspends the user, and never deletes' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return [pscustomobject]@{ groups = @([pscustomobject]@{ email = 'staff@brightonpark.com' }) } }
            return $null
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }
        $r = Invoke-CtgGoogleOffboarding -User $user -Config ([pscustomobject]@{})
        $r.Evidence.Groups | Should -Contain 'staff@brightonpark.com'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'PUT' -and $Body.suspended -eq $true } -Times 1
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' -and $Path -like '/users/*' } -Times 0 -Exactly
    }
}

Describe 'Confirm-CtgGoogle' {
    It 'onboard: passes when present and not in Root OU' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Active Users'; suspended = $false } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when suspended and moved to the Inactive OU' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Email & Calendar/Inactive'; suspended = $true } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: fails when the user is still active' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Active Users'; suspended = $false } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}
