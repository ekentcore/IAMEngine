#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Spanning. Mocks the HTTP seam (Invoke-CtgSpanningApi). Endpoints +
# shapes verified LIVE against a real tenant (external API):
#   user objects: { displayName, userPrincipalName, email, assigned:bool, isArchive:bool,
#                   isAdmin, isDeleted, msId }   (legacy docs: licensed/archived — also read)
#   POST /users/assign   { userPrincipalNames, licenseType: STANDARD|ARCHIVE }
#   POST /users/unassign { userPrincipalNames }
# The BEHAVIOUR these tests pin: onboard assigns a STANDARD license (idempotent; clean no-op when the
# user isn't discovered yet); offboard retains backups and swaps to ARCHIVE (never deletes data).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Spanning/Coretelligent.Spanning.psm1" -Force
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Browser/Coretelligent.Browser.psm1" -Force
}

Describe 'Invoke-CtgSpanningOnboarding' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'assigns a STANDARD license when the user is present and unlicensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ userPrincipalName = 'jdoe@medipost.com'; email = 'jdoe@medipost.com'; assigned = $false; isArchive = $false; isDeleted = $false } }
            return [pscustomobject]@{ licensed = $true }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }
        $r = Invoke-CtgSpanningOnboarding -User $user -Config ([pscustomobject]@{ syncList = $true; assignLicense = $true; procureIfUnavailable = $true })
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/assign' -and $Body.licenseType -eq 'STANDARD' -and $Body.userPrincipalNames -contains 'jdoe@medipost.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'assigned Spanning Backup Standard'
    }

    It 'is idempotent — no assign when the user is already licensed (external assigned field)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $false; isDeleted = $false } }
        $r = Invoke-CtgSpanningOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{ assignLicense = $true })
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already enabled'
    }

    It 'exits cleanly when Spanning has not discovered the user yet (404)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { throw 'Response status code 404 not found' }
            return $null
        }
        $r = Invoke-CtgSpanningOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'new@medipost.com' }) -Config ([pscustomobject]@{ assignLicense = $true })
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'has not discovered'
    }

    It 'reactivates an INACTIVE (isDeleted) user by assigning a license — not "not discovered"' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'back@medipost.com'; userPrincipalName = 'back@medipost.com'; assigned = $false; isArchive = $false; isDeleted = $true } }
            return [pscustomobject]@{ licensed = $true }
        }
        $r = Invoke-CtgSpanningOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'back@medipost.com' }) -Config ([pscustomobject]@{ assignLicense = $true })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'INACTIVE'
        ($r.Actions -join ' ') | Should -Not -Match 'has not discovered'
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' } -Times 1
    }

    It 'warns to open a Procurement Case on a seat error (does not fail the job)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $false; archived = $false } }
            throw 'Subscription does not have any available licenses'
        }
        $r = Invoke-CtgSpanningOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{ assignLicense = $true; procureIfUnavailable = $true })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'Procurement Case'
        ($r.Actions -join ' ') | Should -Match 'WARN'
    }
}

Describe 'Invoke-CtgSpanningOffboarding' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'retains backups and swaps the user to the ARCHIVE license' {
        # Stateful: the tier only reads back as Archive AFTER the assign lands — the executor now proves
        # the swap with a re-read, so a mock that always says isArchive=false is the FAILED-swap case
        # (covered below), not this one.
        $global:SpanArchived = $false
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $global:SpanArchived; isDeleted = $false } }
            if ($Path -eq '/users/assign' -and $Body.licenseType -eq 'ARCHIVE') { $global:SpanArchived = $true }
            return [pscustomobject]@{ licensed = $true }
        }
        $config = [pscustomobject]@{ afterMailboxConvertAndLicenseRemoval = $true; swapLicense = [pscustomobject]@{ from = 'Shared Mailbox'; to = 'Archive' }; procureIfUnavailable = $true }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/assign' -and $Body.licenseType -eq 'ARCHIVE' -and $Body.userPrincipalNames -contains 'jdoe@medipost.com' } -Times 1
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Path -match 'unassign' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'retaining existing backups'
        ($r.Actions -join ' ') | Should -Match 'swapped Spanning license'
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'
        Remove-Variable -Name SpanArchived -Scope Global -ErrorAction SilentlyContinue
    }

    It 'WARNs (and never claims success) when the ARCHIVE swap is a no-op — the leaver is still on a billable Standard seat' {
        # Kaseya cannot convert Standard -> Archive: /users/assign is a no-op and the tier never changes.
        # This used to return a clean success while leaving the user backing up on a paid seat.
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $false; isDeleted = $false } }
            return [pscustomobject]@{ licensed = $false }   # vendor: "already had a license" == the swap did NOT happen
        }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ from = 'Standard'; to = 'Archive' } }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        ($r.Actions -join ' ') | Should -Match 'WARN Spanning license NOT swapped'
        ($r.Actions -join ' ') | Should -Match 'still on a billable STANDARD seat'
        ($r.Actions -join ' ') | Should -Match 'Activate Archived'      # the manual instruction for the engineer
        ($r.Actions -join ' ') | Should -Not -Match 'swapped Spanning license:'
        # The backups must never be unassigned to force the tier (Kaseya: deactivating can delete data).
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Path -match 'unassign' } -Times 0 -Exactly
        $r.Status | Should -Be 'ok'   # the offboard itself still succeeded; this is a warning, not a failure
    }

    It 'is idempotent — no swap when already on the Archive license (legacy archived field still read)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $false; archived = $true } }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ from = 'Standard'; to = 'Archive' } }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already Archive'
    }

    It 'unassigns (frees the seat) when removeLicense is set' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $true; archived = $false } }
            return [pscustomobject]@{ licensed = $false }
        }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{ removeLicense = $true })
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/unassign' -and $Body.userPrincipalNames -contains 'jdoe@medipost.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'seat freed'
    }

    It 'is a no-op when the user is not in Spanning' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { throw '404 not found' }
            return $null
        }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@medipost.com' }) -Config ([pscustomobject]@{ swapLicense = [pscustomobject]@{ to = 'Archive' } })
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Find-CtgSpanningUser (list fallback)' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'falls back to paging the user list when the per-user route returns 400' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Path -match '^/users/') { throw 'Spanning API: GET https://o365-api-us.spanningbackup.com/external/users/x -> HTTP 400 — Bad Request' }
            return [pscustomobject]@{ users = @(
                [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $false; isDeleted = $true },
                [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $false; isDeleted = $false }
            ) }
        }
        $u = Find-CtgSpanningUser -Email 'JDOE@medipost.com'
        $u.email | Should -Be 'jdoe@medipost.com'
        $u.isDeleted | Should -BeFalse
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Path -match '^/users\?size=' } -Times 1
    }

    It 'returns an INACTIVE (isDeleted) user when that is the only record (so onboarding can reactivate)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Path -match '^/users/') { throw 'Spanning API: GET .../users/x -> HTTP 400 — Bad Request' }
            return [pscustomobject]@{ users = @([pscustomobject]@{ email = 'inactive@medipost.com'; assigned = $false; isDeleted = $true }) }
        }
        $u = Find-CtgSpanningUser -Email 'inactive@medipost.com'
        $u | Should -Not -BeNullOrEmpty
        $u.isDeleted | Should -BeTrue
    }

    It 'still treats 404 as user-not-present (no fallback, returns null)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { throw 'Spanning API: GET .../users/x -> HTTP 404' }
        Find-CtgSpanningUser -Email 'gone@medipost.com' | Should -BeNullOrEmpty
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -Times 1 -Exactly
    }

    It 'rethrows non-400/404 errors (e.g. 401) instead of swallowing them' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { throw 'Spanning API: GET .../users/x -> HTTP 401' }
        { Find-CtgSpanningUser -Email 'jdoe@medipost.com' } | Should -Throw '*401*'
    }
}

Describe 'Test-CtgSpanningSeatError' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'classifies a real out-of-seats message as a seat error' {
        Test-CtgSpanningSeatError 'Subscription does not have any available licenses' | Should -BeTrue
    }

    It 'does NOT classify a rate-limit error as a seat error' {
        Test-CtgSpanningSeatError 'rate limit exceeded — retry later' | Should -BeFalse
    }
}

Describe 'Invoke-CtgSpanningOffboarding (response honesty)' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'reports licensed=false honestly instead of claiming the swap happened' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $true; archived = $false } }
            return [pscustomobject]@{ licensed = $false }   # vendor: "already had a license" — tier may not have changed
        }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ from = 'Standard'; to = 'Archive' } }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        ($r.Actions -join ' ') | Should -Match 'licensed=false'
        ($r.Actions -join ' ') | Should -Not -Match 'swapped Spanning license:'
    }
}

Describe 'Confirm-CtgSpanning (config-aware)' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'onboard: passes when assignLicense is disabled in config' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { throw '404 not found' }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{ assignLicense = $false }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when the user was never in Spanning (nothing to retain)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { throw '404 not found' }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ to = 'Archive' } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'gone@medipost.com' }) -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}

Describe 'Confirm-CtgSpanning' {
    BeforeEach { InModuleScope Coretelligent.Spanning { $script:SpanningUserRouteBroken = $false } }
    It 'onboard: passes when the user is present and licensed (external assigned field)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $false; isDeleted = $false } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: fails when the user is unlicensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $false; isArchive = $false; isDeleted = $false } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when backups are retained on the Archive license (external isArchive field)' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $true; isDeleted = $false } }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ to = 'Archive' } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}

Describe 'Invoke-CtgSpanningForceSync — MFA source' {
    BeforeEach {
        $script:captured = $null
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            param($Flow, $InputObject)
            $script:captured = $InputObject
            [pscustomobject]@{ ok = $true; message = 'sync triggered'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $script:secret = [pscustomobject]@{
            Fields = @{ PortalUsername = 'admin@x.com'; PortalPassword = 'pw' }
        }
        $script:user = [pscustomobject]@{ UserPrincipalName = 'new.user@x.com' }
    }

    # The console is Microsoft 365 SSO, so it needs a real M365 USER login. The Spanning API
    # clientId/accessToken is not an M365 identity: it cannot authenticate, produces an unexplained
    # bad-password error, and repeated automated attempts are how an account gets locked out.
    #
    # A client wired before the portal secret existed brokers only 'spanning' (the API credential), and
    # the dispatch falls back to it — so this is the path that MUST refuse, and it must name the fix.
    It 'refuses to sign in with the Spanning API credential (never launches the browser)' {
        $apiOnly = [pscustomobject]@{ Fields = @{ ClientID = 'abc123-clientid'; 'Access Token' = 'tok_live_xyz' } }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $apiOnly -SecretName 'spanning'
        $r.Status | Should -Be 'ok'   # a WARN, never a case failure
        ($r.Actions -join ' ') | Should -Match 'no portal login is available'
        ($r.Actions -join ' ') | Should -Match "CANNOT sign in to the console"
        ($r.Actions -join ' ') | Should -Match "spanning-portal"   # names the secret to wire
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0 -Exactly
    }

    # The dedicated portal secret exists but is empty — a different fix, so a different message.
    It 'names the portal secret (not the API one) when the portal secret has no username/password' {
        $empty = [pscustomobject]@{ Fields = @{ Region = 'US' } }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $empty -SecretName 'spanning-portal'
        ($r.Actions -join ' ') | Should -Match "the 'spanning-portal' secret has no Username/Password"
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0 -Exactly
    }

    # On a DEDICATED portal secret the generic Username/Password pair is the natural place for the login
    # — and unambiguous there, since that secret holds no API credential to be confused with.
    It 'accepts a generic Username/Password pair on the dedicated portal secret' {
        $portal = [pscustomobject]@{ Fields = @{ Username = 'admin@x.com'; Password = 'pw' } }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $portal -SecretName 'spanning-portal'
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 1 -Exactly
    }

    # An API clientId dropped into a Username slot would otherwise be typed at the Microsoft sign-in box.
    It 'refuses a portal username that is not an email/UPN' {
        $notEmail = [pscustomobject]@{ Fields = @{ PortalUsername = 'abc123-clientid'; PortalPassword = 'pw' } }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $notEmail
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'is not an email/UPN'
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0 -Exactly
    }

    It 'passes the Delinea-minted CODE to the flow and never a seed' {
        $provider = { [pscustomobject]@{ Code = '123456'; RemainingSeconds = 27 } }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $script:secret -OtpProvider $provider
        $r.Status | Should -Be 'ok'
        $script:captured.params.otpCode | Should -Be '123456'
        $script:captured.params.ContainsKey('totpSeed') | Should -BeFalse
    }

    It 'falls back to a stored seed only when Delinea has no one-time password' {
        $script:secret.Fields['TOTPSeed'] = 'JBSWY3DPEHPK3PXP'
        $provider = { $null }   # Delinea could not mint a code
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $script:secret -OtpProvider $provider
        $r.Status | Should -Be 'ok'
        $script:captured.params.totpSeed | Should -Be 'JBSWY3DPEHPK3PXP'
        $script:captured.params.ContainsKey('otpCode') | Should -BeFalse
        ($r.Actions -join ' ') | Should -Match 'enable One-Time Password'   # nudges to the better path
    }
}

Describe 'Invoke-CtgSpanningForceSync — in-flow OTP minting' {
    BeforeEach {
        $script:captured = $null
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            param($Flow, $InputObject)
            $script:captured = $InputObject
            [pscustomobject]@{ ok = $true; message = 'sync triggered'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $script:secret = [pscustomobject]@{
            Fields = @{ PortalUsername = 'admin@x.com'; PortalPassword = 'pw' }
        }
        $script:user = [pscustomobject]@{ UserPrincipalName = 'new.user@x.com' }
    }

    It 'passes the OTP request spec through so the FLOW mints at the MFA prompt (no pre-mint)' {
        $providerInvoked = $false
        $provider = { $script:providerInvoked = $true; [pscustomobject]@{ Code = '999999'; RemainingSeconds = 29 } }
        $req = @{ url = 'https://app/api/jobs/j1/credential'; token = 't'; agentId = 'a1'; secretName = 'spanning' }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $script:secret -OtpRequest $req -OtpProvider $provider
        $r.Status | Should -Be 'ok'
        $script:captured.params.otp.url | Should -Be 'https://app/api/jobs/j1/credential'
        $script:captured.params.otp.secretName | Should -Be 'spanning'
        $script:captured.params.ContainsKey('otpCode') | Should -BeFalse   # nothing pre-minted
        $providerInvoked | Should -BeFalse                                  # provider skipped entirely
        ($r.Actions -join ' ') | Should -Match 'minted by Delinea at the MFA prompt'
    }

    It 'still ships the stored seed alongside the request spec as the flow-side last resort' {
        $script:secret.Fields['TOTPSeed'] = 'JBSWY3DPEHPK3PXP'
        $req = @{ url = 'https://app/api/jobs/j1/credential'; token = 't'; agentId = 'a1'; secretName = 'spanning' }
        $r = Invoke-CtgSpanningForceSync -User $script:user -Config ([pscustomobject]@{}) -Secret $script:secret -OtpRequest $req
        $script:captured.params.otp | Should -Not -BeNullOrEmpty
        $script:captured.params.totpSeed | Should -Be 'JBSWY3DPEHPK3PXP'
        # no WARN nag when the preferred path is wired — the seed is just the fallback
        ($r.Actions -join ' ') | Should -Not -Match 'WARN using a stored TOTP seed'
    }
}

# The connection test for the CONSOLE sign-in. Its value is entirely in being the same code path the
# force-sync uses (so it can't go green on a credential the real sync would choke on) while changing
# nothing at the client — hence signInOnly, and hence the "never fires a sync" assertions.
Describe 'Test-CtgSpanningPortalLogin (console sign-in connection test)' {
    BeforeEach {
        $script:captured = $null
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            param($Flow, $InputObject, $TimeoutSeconds)
            $script:captured = $InputObject
            [pscustomobject]@{ ok = $true; message = 'signed in to the Spanning console at https://o365-us.spanningbackup.com'; error = $null }
        }
        $script:portal = [pscustomobject]@{ Fields = @{ Username = 'admin@x.com'; Password = 'pw' } }
    }

    It 'signs in with signInOnly so the test can never trigger a real sync' {
        $r = Test-CtgSpanningPortalLogin -Secret $script:portal -SecretName 'spanning-portal'
        $r.Ok | Should -BeTrue
        $script:captured.params.signInOnly | Should -BeTrue
        # No target user: a sign-in check is about the ADMIN credential, not about any leaver/joiner.
        $script:captured.params.ContainsKey('email') | Should -BeFalse
        $r.Detail | Should -Match 'admin@x.com'
    }

    It 'mints the MFA code at the prompt (passes the OTP request spec, never a pre-minted code)' {
        $otpReq = @{ url = 'https://app/api/runner/conn-tests/t1/credential'; token = 'tok'; agentId = 'a1'; secretName = 'spanning-portal' }
        $r = Test-CtgSpanningPortalLogin -Secret $script:portal -SecretName 'spanning-portal' -OtpRequest $otpReq
        $r.Ok | Should -BeTrue
        $script:captured.params.otp.url | Should -Be 'https://app/api/runner/conn-tests/t1/credential'
        $script:captured.params.ContainsKey('otpCode') | Should -BeFalse
    }

    # The API credential can't sign in to the console — and must not be typed at Microsoft's login box
    # even by a TEST. A conn test that burned failed sign-ins would itself walk the account to lockout.
    It 'refuses the API credential without ever launching the browser' {
        $apiOnly = [pscustomobject]@{ Fields = @{ ClientID = 'abc123'; ClientSecret = 'shh' } }
        $r = Test-CtgSpanningPortalLogin -Secret $apiOnly -SecretName 'spanning'
        $r.Ok | Should -BeFalse
        $r.Detail | Should -Match 'spanning-portal'
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0 -Exactly
    }

    It 'reports a failed sign-in as a failed check rather than throwing' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $false; error = 'Microsoft rejected the sign-in: your account or password is incorrect'; message = $null }
        }
        $r = Test-CtgSpanningPortalLogin -Secret $script:portal -SecretName 'spanning-portal'
        $r.Ok | Should -BeFalse
        $r.Detail | Should -Match 'password is incorrect'
    }
}

# The single gate on what may be typed into Microsoft's sign-in box. Both the force-sync and its
# connection test resolve the credential through here, so it is tested directly.
Describe 'Resolve-CtgSpanningPortalLogin' {
    It 'never reads the API-credential field names, even when they are the only fields present' {
        $apiOnly = [pscustomobject]@{ Fields = @{ ClientID = 'abc'; ClientSecret = 'shh'; 'Access Token' = 'tok'; 'API Key' = 'k' } }
        $r = Resolve-CtgSpanningPortalLogin -Secret $apiOnly -SecretName 'spanning-portal'
        $r.Ok | Should -BeFalse
        $r.Username | Should -BeNullOrEmpty
        $r.Password | Should -BeNullOrEmpty
    }

    It 'never echoes the rejected value (it is credential material bound for the audit log)' {
        $notEmail = [pscustomobject]@{ Fields = @{ Username = 'abc123-secret-clientid'; Password = 'pw' } }
        $r = Resolve-CtgSpanningPortalLogin -Secret $notEmail -SecretName 'spanning-portal'
        $r.Ok | Should -BeFalse
        $r.Reason | Should -Not -Match 'abc123-secret-clientid'
    }

    It 'prefers the explicit Portal* fields over the generic pair' {
        $both = [pscustomobject]@{ Fields = @{ PortalUsername = 'portal@x.com'; PortalPassword = 'p1'; Username = 'other@x.com'; Password = 'p2' } }
        $r = Resolve-CtgSpanningPortalLogin -Secret $both -SecretName 'spanning-portal'
        $r.Ok | Should -BeTrue
        $r.Username | Should -Be 'portal@x.com'
        $r.Password | Should -Be 'p1'
    }
}

Describe 'Connect-CtgSpanning BaseUrl scheme normalization' {
    # A scheme-less or http:// apiURL must never leave the module on port 80 — Spanning is HTTPS-only
    # and port 80 black-holes, hanging the runner (same failure mode as the Proofpoint wedge).
    It 'prepends https:// and /external for a scheme-less bare host' {
        Connect-CtgSpanning -Username 'u' -AccessToken 't' -BaseUrl 'o365-api-us.spanningbackup.com'
        InModuleScope Coretelligent.Spanning { $script:SpanningApiUrl | Should -Be 'https://o365-api-us.spanningbackup.com/external' }
    }
    It 'upgrades an http:// override to https://' {
        Connect-CtgSpanning -Username 'u' -AccessToken 't' -BaseUrl 'http://o365-api-us.spanningbackup.com/external'
        InModuleScope Coretelligent.Spanning { $script:SpanningApiUrl | Should -Be 'https://o365-api-us.spanningbackup.com/external' }
    }
    It 'leaves a proper https:// override untouched' {
        Connect-CtgSpanning -Username 'u' -AccessToken 't' -BaseUrl 'https://o365-api-eu.spanningbackup.com/external'
        InModuleScope Coretelligent.Spanning { $script:SpanningApiUrl | Should -Be 'https://o365-api-eu.spanningbackup.com/external' }
    }
}
