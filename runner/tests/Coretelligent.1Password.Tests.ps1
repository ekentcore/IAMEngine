#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.1Password. Mocks the CLI seam (Invoke-Ctg1PasswordCli) — no real `op`.
# Behaviour pinned: api onboard invites an absent user (idempotent for an existing one); api offboard
# suspends; auto falls back to a manual checklist when no admin session; scim/manual emit notes without
# touching the CLI; Confirm verdicts by method/state.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.1Password/Coretelligent.1Password.psm1" -Force
}

Describe 'Invoke-Ctg1PasswordOnboarding (api / auto)' {
    It 'invites an ABSENT user (op user provision)' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith {
            param($OpArgs, $AllowFail, $Raw)
            if ($OpArgs[0] -eq 'user' -and $OpArgs[1] -eq 'get') { return $null }     # not found
            return [pscustomobject]@{ uuid = 'abc'; email = 'jane@acme.com' }          # provision ok
        }
        $u = [pscustomobject]@{ UserPrincipalName = 'jane@acme.com'; DisplayName = 'Jane Doe' }
        $r = Invoke-Ctg1PasswordOnboarding -User $u -Config ([pscustomobject]@{ method = 'api' }) -Connected $true
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'invited 1Password user'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -ParameterFilter { $OpArgs[0] -eq 'user' -and $OpArgs[1] -eq 'provision' -and ($OpArgs -contains 'jane@acme.com') } -Times 1
    }

    It 'is idempotent — does NOT provision a user already present' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith {
            param($OpArgs, $AllowFail, $Raw)
            if ($OpArgs[0] -eq 'user' -and $OpArgs[1] -eq 'get') { return [pscustomobject]@{ email = 'jane@acme.com'; state = 'ACTIVE' } }
            throw 'should not provision'
        }
        $r = Invoke-Ctg1PasswordOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Connected $true
        ($r.Actions -join ' ') | Should -Match 'already present'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -ParameterFilter { $OpArgs[1] -eq 'provision' } -Times 0
    }

    It 'auto: with no admin session, falls back to a MANUAL checklist (no CLI call)' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith { throw 'should not be called' }
        $r = Invoke-Ctg1PasswordOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com'; DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{ method = 'auto' }) -Connected $false
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'MANUAL: invite'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -Times 0
    }

    It 'api: with no admin session, THROWS (api requires it)' {
        { Invoke-Ctg1PasswordOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Connected $false } | Should -Throw '*needs an admin*'
    }
}

Describe 'Invoke-Ctg1PasswordOnboarding (scim / manual)' {
    It 'scim: records a note, never calls the CLI' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith { throw 'should not be called' }
        $r = Invoke-Ctg1PasswordOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'scim'; scimGroup = '1Password Users' }) -Connected $false
        ($r.Actions -join ' ') | Should -Match 'Entra SCIM'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -Times 0
    }
    It 'manual: emits a guided checklist line' {
        $r = Invoke-Ctg1PasswordOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com'; DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{ method = 'manual'; signInAddress = 'acme.1password.com' }) -Connected $false
        ($r.Actions -join ' ') | Should -Match 'MANUAL: invite Jane Doe <jane@acme.com>'
    }
}

Describe 'Invoke-Ctg1PasswordOffboarding' {
    It 'api: suspends a present, active user' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith {
            param($OpArgs, $AllowFail, $Raw)
            if ($OpArgs[0] -eq 'user' -and $OpArgs[1] -eq 'get') { return [pscustomobject]@{ email = 'jane@acme.com'; state = 'ACTIVE' } }
            return $null
        }
        $r = Invoke-Ctg1PasswordOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Connected $true
        ($r.Actions -join ' ') | Should -Match 'suspended 1Password user'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -ParameterFilter { $OpArgs[1] -eq 'suspend' } -Times 1
    }
    It 'api: idempotent — already suspended is a no-op' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith {
            param($OpArgs, $AllowFail, $Raw)
            if ($OpArgs[1] -eq 'get') { return [pscustomobject]@{ email = 'jane@acme.com'; state = 'SUSPENDED' } }
            throw 'should not suspend'
        }
        $r = Invoke-Ctg1PasswordOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Connected $true
        ($r.Actions -join ' ') | Should -Match 'already suspended'
        Should -Invoke Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -ParameterFilter { $OpArgs[1] -eq 'suspend' } -Times 0
    }
}

Describe 'Confirm-Ctg1Password' {
    It 'onboard (api/connected): passes when the user is present' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith { [pscustomobject]@{ email = 'jane@acme.com'; state = 'ACTIVE' } }
        $r = Confirm-Ctg1Password -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Action 'onboard' -Connected $true
        $r.ok | Should -BeTrue
    }
    It 'offboard (api/connected): passes when suspended' {
        Mock Invoke-Ctg1PasswordCli -ModuleName Coretelligent.1Password -MockWith { [pscustomobject]@{ email = 'jane@acme.com'; state = 'SUSPENDED' } }
        $r = Confirm-Ctg1Password -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'api' }) -Action 'offboard' -Connected $true
        $r.ok | Should -BeTrue
    }
    It 'scim/no session: passes with a "not auto-verified" note' {
        $r = Confirm-Ctg1Password -User ([pscustomobject]@{ UserPrincipalName = 'jane@acme.com' }) -Config ([pscustomobject]@{ method = 'scim' }) -Action 'onboard' -Connected $false
        $r.ok | Should -BeTrue
        ($r.checks.name -join ' ') | Should -Match 'not auto-verified'
    }
}
