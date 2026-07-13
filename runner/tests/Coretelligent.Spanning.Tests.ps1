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
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; assigned = $true; isArchive = $false; isDeleted = $false } }
            return [pscustomobject]@{ licensed = $true }
        }
        $config = [pscustomobject]@{ afterMailboxConvertAndLicenseRemoval = $true; swapLicense = [pscustomobject]@{ from = 'Shared Mailbox'; to = 'Archive' }; procureIfUnavailable = $true }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/assign' -and $Body.licenseType -eq 'ARCHIVE' -and $Body.userPrincipalNames -contains 'jdoe@medipost.com' } -Times 1
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Path -match 'unassign' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'retaining existing backups'
        ($r.Actions -join ' ') | Should -Match 'Archive'
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
