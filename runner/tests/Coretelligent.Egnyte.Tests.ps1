#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Egnyte. Mocks the HTTP seam (Invoke-CtgEgnyteApi); no live tenant.
# API: User Management v2 — GET /pubapi/v2/users?filter=email eq "x", POST /pubapi/v2/users,
# PATCH/DELETE /pubapi/v2/users/{id}. The BEHAVIOUR pinned: create with the configured license
# tier (default POWER), idempotent on existing users (reactivating if needed), retention-safe
# deactivate on offboard (delete only with config delete=true).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Egnyte/Coretelligent.Egnyte.psm1" -Force
}

Describe 'Invoke-CtgEgnyteOnboarding' {
    It 'creates a power user by default with an invite' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ resources = @() } }
            return [pscustomobject]@{ id = 'u1' }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com'; GivenName = 'Jane'; Surname = 'Doe'; DisplayName = 'Jane Doe' }
        $r = Invoke-CtgEgnyteOnboarding -User $user -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter {
            $Method -eq 'POST' -and $Path -eq '/pubapi/v2/users' -and $Body.userType -eq 'power' -and $Body.email -eq 'jdoe@drakestar.com' -and $Body.sendInvite -eq $true
        } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Egnyte user.*power'
    }

    It 'honors a configured userType (not always power)' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ resources = @() } }
            return [pscustomobject]@{ id = 'u1' }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com'; DisplayName = 'Jane Doe' }
        Invoke-CtgEgnyteOnboarding -User $user -Config ([pscustomobject]@{ userType = 'standard' }) | Out-Null
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'POST' -and $Body.userType -eq 'standard' } -Times 1
    }

    It 'is idempotent — existing active user means no create' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            return [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $true; userType = 'power' }) }
        }
        $r = Invoke-CtgEgnyteOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com'; DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }

    It 'reactivates an existing deactivated user instead of creating' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $false; userType = 'power' }) } }
            return $null
        }
        $r = Invoke-CtgEgnyteOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com'; DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'PATCH' -and $Path -match 'u1' -and $Body.active -eq $true } -Times 1
        ($r.Actions -join ' ') | Should -Match 'reactivated'
    }
}

Describe 'Invoke-CtgEgnyteOffboarding' {
    It 'deactivates (not deletes) by default — retention-safe' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $true }) } }
            return $null
        }
        $r = Invoke-CtgEgnyteOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'PATCH' -and $Body.active -eq $false } -Times 1
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'deactivated'
    }

    It 'deletes when config delete=true' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $true }) } }
            return $null
        }
        $r = Invoke-CtgEgnyteOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{ delete = $true })
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -eq 'DELETE' -and $Path -match 'u1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'deleted'
    }

    It 'is a no-op when the user is absent' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith { [pscustomobject]@{ resources = @() } }
        $r = Invoke-CtgEgnyteOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@drakestar.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgEgnyte' {
    It 'onboard: passes when present, active, and on the configured license' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $true; userType = 'power' }) }
        }
        $r = Confirm-CtgEgnyte -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{ userType = 'power' }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: fails when the license tier differs from config' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $true; userType = 'standard' }) }
        }
        $r = Confirm-CtgEgnyte -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{ userType = 'power' }) -Action 'onboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when the user is deactivated' {
        Mock Invoke-CtgEgnyteApi -ModuleName Coretelligent.Egnyte -MockWith {
            [pscustomobject]@{ resources = @([pscustomobject]@{ id = 'u1'; email = 'jdoe@drakestar.com'; active = $false }) }
        }
        $r = Confirm-CtgEgnyte -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}
