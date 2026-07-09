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

    It 'is idempotent — skips create (and re-license) when the user already exists as Licensed' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1'; type = 2 } } # already Licensed
            return $null
        }
        $r = Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{ type = 2 })
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PATCH' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }

    It 'upgrades an existing Basic user to Licensed (PATCH type) without re-creating' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1'; type = 1 } } # currently Basic
            return $null
        }
        $r = Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{ type = 2 })
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PATCH' -and $Path -eq '/users/jdoe@61commodities.com' -and [int]$Body.type -eq 2 } -Times 1
        ($r.Actions -join ' ') | Should -Match 'set Zoom license: Basic -> Licensed'
    }

    It 'assigns a Zoom Phone calling plan + number when phone is configured' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/phone/users/*') { return $null }   # not yet a phone user
            if ($Method -eq 'GET') { return $null }                                       # zoom user not found
            return [pscustomobject]@{ id = 'zoom-1' }
        }
        $r = Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{ type = 2; phone = @{ callingPlanType = 200; number = '+15551230000' } })
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' -and $Path -like '*/calling_plans' } -Times 1
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' -and $Path -like '*/phone_numbers' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'calling plan'
    }

    It 'does not touch Zoom Phone when phone is not configured' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return $null }
            return [pscustomobject]@{ id = 'zoom-1' }
        }
        Invoke-CtgZoomOnboarding -User $user -Config ([pscustomobject]@{ type = 2 }) | Out-Null
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Path -like '/phone/*' } -Times 0 -Exactly
    }

    It 'resolves the email from the `email` field when UserPrincipalName is empty' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return $null }
            return [pscustomobject]@{ id = 'zoom-1' }
        }
        $u = [pscustomobject]@{ UserPrincipalName = ''; email = 'jdoe@61commodities.com'; FirstName = 'Jane'; LastName = 'Doe' }
        $r = Invoke-CtgZoomOnboarding -User $u -Config ([pscustomobject]@{ type = 2 })
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Zoom user'
    }
}

Describe 'Zoom display-name resolution (no email on the case)' {
    It 'offboard: resolves the user by display name against the Zoom user list, then deactivates' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            # status-aware: the user is ACTIVE, so only the active page returns them.
            if ($Method -eq 'GET' -and $Path -like '/users[?]*status=active*') {
                return [pscustomobject]@{ users = @(
                        [pscustomobject]@{ first_name = 'Ryan'; last_name = 'McNulty'; email = 'rmcnulty@coretelligent.com' }
                        [pscustomobject]@{ first_name = 'Someone'; last_name = 'Else'; email = 'else@coretelligent.com' }
                    ); next_page_token = '' }
            }
            if ($Method -eq 'GET' -and $Path -like '/users[?]*') { return [pscustomobject]@{ users = @(); next_page_token = '' } }
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ id = 'z1'; email = 'rmcnulty@coretelligent.com'; status = 'active' } }
            return $null  # PUT status / DELETE token
        }
        $u = [pscustomobject]@{ UserPrincipalName = ''; displayName = 'Ryan McNulty' }
        $r = Invoke-CtgZoomOffboarding -User $u -Config ([pscustomobject]@{})
        ($r.Actions -join ' ') | Should -Match "resolved Zoom user by display name 'Ryan McNulty' -> rmcnulty@coretelligent.com"
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PUT' -and $Path -match 'rmcnulty@coretelligent.com/status' -and $Body.action -eq 'deactivate' } -Times 1
    }

    It 'offboard: an ALREADY-deactivated user is found (inactive list) and reported, not re-deactivated' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            # Ryan is INACTIVE — only the inactive page returns him (the active list would miss him).
            if ($Method -eq 'GET' -and $Path -like '/users[?]*status=inactive*') {
                return [pscustomobject]@{ users = @([pscustomobject]@{ first_name = 'Ryan'; last_name = 'McNulty'; email = 'rmcnulty@coretelligent.com' }); next_page_token = '' }
            }
            if ($Method -eq 'GET' -and $Path -like '/users[?]*') { return [pscustomobject]@{ users = @(); next_page_token = '' } }
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ id = 'z1'; email = 'rmcnulty@coretelligent.com'; status = 'inactive' } }
            return $null
        }
        $r = Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = ''; displayName = 'Ryan McNulty' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'already deactivated'
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PUT' } -Times 0 -Exactly
    }

    It 'offboard: refuses on an ambiguous display-name match (two users, same name)' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users[?]*status=active*') {
                return [pscustomobject]@{ users = @(
                        [pscustomobject]@{ first_name = 'Ryan'; last_name = 'McNulty'; email = 'rmcnulty1@coretelligent.com' }
                        [pscustomobject]@{ first_name = 'Ryan'; last_name = 'McNulty'; email = 'rmcnulty2@coretelligent.com' }
                    ); next_page_token = '' }
            }
            if ($Method -eq 'GET' -and $Path -like '/users[?]*') { return [pscustomobject]@{ users = @(); next_page_token = '' } }
            return $null
        }
        $r = Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = ''; displayName = 'Ryan McNulty' }) -Config ([pscustomobject]@{})
        ($r.Actions -join ' ') | Should -Match "2 Zoom users match display name 'Ryan McNulty'"
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'PUT' } -Times 0 -Exactly
    }

    It 'offboard: skips gracefully (no crash) when there is no email AND no display name' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { throw 'should not be called' }
        $r = Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = '' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no email/UPN on the case'
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -Times 0 -Exactly
    }

    It 'confirm: passes as nothing-to-verify when there is no email or display name' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { throw 'should not be called' }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = '' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -Times 0 -Exactly
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

    It 'revokes the SSO token after deactivating (by default)' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1' } }
            return $null
        }
        $r = Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Method -eq 'DELETE' -and $Path -match '/token$' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'revoked Zoom SSO token'
    }

    It 'does NOT revoke a token on delete (the user is gone) and skips it when revokeSso is false' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id = 'zoom-1' } }
            return $null
        }
        Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{ delete = $true }) | Out-Null
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Path -match '/token$' } -Times 0 -Exactly
        Invoke-CtgZoomOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{ revokeSso = $false }) | Out-Null
        Should -Invoke Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -ParameterFilter { $Path -match '/token$' } -Times 0 -Exactly
    }
}

Describe 'Connect-CtgZoom' {
    It 'requests a server-to-server account_credentials token' {
        Mock Invoke-RestMethod -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ access_token = 'tok-z'; expires_in = 3600 } }
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        Connect-CtgZoom -Credential $cred -AccountId 'acct-1'
        Should -Invoke Invoke-RestMethod -ModuleName Coretelligent.Zoom -ParameterFilter { $Uri -match 'grant_type=account_credentials' } -Times 1
    }

    It 'wraps a Zoom token error with an actionable message (not the opaque 400)' {
        Mock Invoke-RestMethod -ModuleName Coretelligent.Zoom -MockWith { throw 'Response status code does not indicate success: 400 ().' }
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        { Connect-CtgZoom -Credential $cred -AccountId 'acct-1' } | Should -Throw '*Zoom token request failed*'
    }

    It 'fails clearly when the Account ID is blank' {
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        { Connect-CtgZoom -Credential $cred -AccountId ' ' } | Should -Throw '*no Account ID*'
    }

    It 'detects a smart-quote (non-ASCII) in the Client Secret and names the field' {
        # U+2019 right single quote — the copy-paste artifact behind a "looks right" invalid_client.
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString "g$([char]0x2019)yGhBn8" -AsPlainText -Force))
        { Connect-CtgZoom -Credential $cred -AccountId 'acct-1' } | Should -Throw '*Client Secret*non-ASCII*'
    }
}

Describe 'Confirm-CtgZoom' {
    It 'onboard: passes when the user is present AND holds the expected license' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ id = 'zoom-1'; email = 'jdoe@61commodities.com'; status = 'active'; type = 2 } }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{ type = 2 }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: FAILS when the user is present but still Basic (license not applied)' {
        Mock Invoke-CtgZoomApi -ModuleName Coretelligent.Zoom -MockWith { [pscustomobject]@{ id = 'zoom-1'; status = 'active'; type = 1 } }
        $r = Confirm-CtgZoom -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }) -Config ([pscustomobject]@{ type = 2 }) -Action 'onboard'
        $r.ok | Should -BeFalse
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
