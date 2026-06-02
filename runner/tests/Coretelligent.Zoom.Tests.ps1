#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Zoom. Mocks the HTTP seam (Invoke-CtgZoomApi). API per the Zoom
# REST v2 docs: create POST /users; deactivate PUT /users/{id}/status {action:deactivate}.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Zoom/Coretelligent.Zoom.psm1" -Force
}

Describe 'Invoke-CtgZoomOnboarding' {
    BeforeEach { $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com'; FirstName = 'Jane'; LastName = 'Doe' } }

    It 'creates a licensed Zoom user when none exists' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return $null }                       # user not found
            return [pscustomobject]@{ id = 'zoom-1'; email = 'jdoe@61commodities.com' }
        }
        $r = Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{ type = 2 })
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Zoom user'
    }

    It 'is idempotent — skips create when the user already exists' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1' } }
            return $null
        }
        $r = Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }
}

Describe 'Invoke-CtgZoomOffboarding' {
    It 'deactivates the user (removes licenses, blocks login)' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1' } }
            return $null
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Invoke-CtgZoomOffboarding -User $user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PUT' -and $Path -match '/status' -and $Body.action -eq 'deactivate' } -Times 1
    }
}

Describe 'Connect-CtgZoom' {
    It 'requests a server-to-server account_credentials token' {
        Mock Invoke-RestMethod -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ access_token = 'tok-z'; expires_in = 3600 } }
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        Connect-CtgZoom -Credential $cred -AccountId 'acct-1'
        Should -Invoke Invoke-RestMethod -ModuleName Coretelligent.Zoom -ParameterFilter { $Uri -match 'grant_type=account_credentials' } -Times 1
    }
}

Describe 'Confirm-CtgZoom' {
    It 'onboard: passes when the user is present' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ id = 'zoom-1'; email = 'jdoe@61commodities.com'; status = 'active' } }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when the user is absent' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { $null }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: fails when the user is still active' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ id = 'zoom-1'; status = 'active' } }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}
