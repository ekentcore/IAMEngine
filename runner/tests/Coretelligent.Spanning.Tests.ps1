#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Spanning. Mocks the HTTP seam (Invoke-CtgSpanningApi). Endpoints +
# shapes are verified against the live Spanning Backup reference (api.spanningbackup.com):
#   GET  /users/{email}            -> { type, email, licensed:bool, archived:bool } | 404
#   POST /users/assign   { emails, licenseType: STANDARD|ARCHIVE }
#   POST /users/unassign { emails }
# The BEHAVIOUR these tests pin: onboard assigns a STANDARD license (idempotent; clean no-op when the
# user isn't discovered yet); offboard retains backups and swaps to ARCHIVE (never deletes data).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Spanning/Coretelligent.Spanning.psm1" -Force
}

Describe 'Invoke-CtgSpanningOnboarding' {
    It 'assigns a STANDARD license when the user is present and unlicensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ type = 'user'; email = 'jdoe@medipost.com'; licensed = $false; archived = $false } }
            return [pscustomobject]@{ licensed = $true }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }
        $r = Invoke-CtgSpanningOnboarding -User $user -Config ([pscustomobject]@{ syncList = $true; assignLicense = $true; procureIfUnavailable = $true })
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/assign' -and $Body.licenseType -eq 'STANDARD' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'assigned Spanning Backup Standard'
    }

    It 'is idempotent — no assign when the user is already licensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $true; archived = $false } }
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
    It 'retains backups and swaps the user to the ARCHIVE license' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $true; archived = $false } }
            return [pscustomobject]@{ licensed = $true }
        }
        $config = [pscustomobject]@{ afterMailboxConvertAndLicenseRemoval = $true; swapLicense = [pscustomobject]@{ from = 'Shared Mailbox'; to = 'Archive' }; procureIfUnavailable = $true }
        $r = Invoke-CtgSpanningOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/assign' -and $Body.licenseType -eq 'ARCHIVE' } -Times 1
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Path -match 'unassign' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'retaining existing backups'
        ($r.Actions -join ' ') | Should -Match 'Archive'
    }

    It 'is idempotent — no swap when already on the Archive license' {
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
        Should -Invoke Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/unassign' } -Times 1
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

Describe 'Test-CtgSpanningSeatError' {
    It 'classifies a real out-of-seats message as a seat error' {
        Test-CtgSpanningSeatError 'Subscription does not have any available licenses' | Should -BeTrue
    }

    It 'does NOT classify a rate-limit error as a seat error' {
        Test-CtgSpanningSeatError 'rate limit exceeded — retry later' | Should -BeFalse
    }
}

Describe 'Invoke-CtgSpanningOffboarding (response honesty)' {
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
    It 'onboard: passes when the user is present and licensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $true; archived = $false } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: fails when the user is unlicensed' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $false; archived = $false } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when backups are retained on the Archive license' {
        Mock Invoke-CtgSpanningApi -ModuleName Coretelligent.Spanning -MockWith { [pscustomobject]@{ email = 'jdoe@medipost.com'; licensed = $false; archived = $true } }
        $config = [pscustomobject]@{ swapLicense = [pscustomobject]@{ to = 'Archive' } }
        $r = Confirm-CtgSpanning -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }) -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}
