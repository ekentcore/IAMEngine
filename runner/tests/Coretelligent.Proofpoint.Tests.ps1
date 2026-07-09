#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Proofpoint. Mocks the HTTP seam (Invoke-CtgProofpointApi). The module is
# READ-ONLY: it verifies whether a user has synced from Azure AD / Entra ID into Proofpoint Essentials
# and returns a status object. It never PUTs settings or modifies exemptions, and Proofpoint has no
# on-demand sync trigger — so onboarding verifies-and-waits (auto-retry until the scheduled sync runs).
#   GET /orgs/{domain}/settings/azure             -> { sync_frequency, last_successful_sync, remove_deleted_users, ... }
#   GET /orgs/{domain}/settings/azure/exemptions  -> exempted users
#   GET /orgs/{domain}/users/{email}              -> the user (404 = not synced yet)

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Proofpoint/Coretelligent.Proofpoint.psm1" -Force
    InModuleScope Coretelligent.Proofpoint {
        $script:PpBaseUrl = 'https://us1.proofpointessentials.com/api/v1'
        $script:PpUser = 'admin@apollon.com'; $script:PpPassword = 'x'; $script:PpDomain = 'apollon.com'
    }
}

Describe 'Get-CtgProofpointSyncStatus' {
    It 'reports a present user (synced) with sync metadata' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @() }
            if ($Path -match '/settings/azure') { return [pscustomobject]@{ sync_frequency = 1; last_successful_sync = '2026-06-30T18:15:00Z'; remove_deleted_users = $true } }
            if ($Path -match '/users/') { return [pscustomobject]@{ email = 'jdoe@apollon.com'; primary_email = 'jdoe@apollon.com'; type = 'end_user' } }
        }
        $st = Get-CtgProofpointSyncStatus -Email 'jdoe@apollon.com'
        $st.proofpoint_user_exists | Should -BeTrue
        $st.azure_sync_enabled     | Should -BeTrue
        $st.sync_frequency_hours   | Should -Be 1
        $st.last_successful_sync   | Should -Be '2026-06-30T18:15:00Z'
        $st.user_is_sync_exempt    | Should -BeFalse
        $st.sync_trigger_supported | Should -Be 'unsupported'
    }

    It 'flags an exempt user that will never import' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @('jdoe@apollon.com') }
            if ($Path -match '/settings/azure') { return [pscustomobject]@{ sync_frequency = 1 } }
            if ($Path -match '/users/') { return $null } # 404 -> AllowFail
        }
        $st = Get-CtgProofpointSyncStatus -Email 'JDoe@apollon.com'   # case-insensitive match
        $st.proofpoint_user_exists | Should -BeFalse
        $st.user_is_sync_exempt    | Should -BeTrue
        $st.recommended_action     | Should -Match 'exemption'
    }
}

Describe 'Invoke-CtgProofpointOnboarding' {
    It 'is ok when the user is already present (synced)' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @() }
            if ($Path -match '/settings/azure') { return [pscustomobject]@{ sync_frequency = 1; last_successful_sync = '2026-06-30T18:15:00Z' } }
            if ($Path -match '/users/') { return [pscustomobject]@{ email = 'jdoe@apollon.com' } }
        }
        $r = Invoke-CtgProofpointOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@apollon.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'present'
        $r.PSObject.Properties.Name | Should -Not -Contain 'RetryAfterMinutes'
    }

    It 'auto-retries when sync is on but the user has not appeared yet' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @() }
            if ($Path -match '/settings/azure') { return [pscustomobject]@{ sync_frequency = 1; last_successful_sync = '2026-06-30T18:15:00Z' } }
            if ($Path -match '/users/') { return $null }  # not synced yet
        }
        $r = Invoke-CtgProofpointOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@apollon.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        $r.RetryAfterMinutes | Should -Be 60
        ($r.Actions -join ' ') | Should -Match 'auto-retrying'
    }

    It 'hard-fails an exempt user (it will never import)' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @('jdoe@apollon.com') }
            if ($Path -match '/settings/azure') { return [pscustomobject]@{ sync_frequency = 1 } }
            if ($Path -match '/users/') { return $null }
        }
        { Invoke-CtgProofpointOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@apollon.com' }) -Config ([pscustomobject]@{}) } |
            Should -Throw -ExpectedMessage '*EXEMPT*'
    }

    It 'warns (not fails) when Azure sync is disabled for the org' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith {
            param($Method, $Path, $Body, [switch]$AllowFail)
            if ($Path -match '/settings/azure/exemptions') { return @() }
            if ($Path -match '/settings/azure') { return $null }   # no settings -> sync not enabled
            if ($Path -match '/users/') { return $null }
        }
        $r = Invoke-CtgProofpointOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@apollon.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN.*not enabled'
    }
}

Describe 'Confirm-CtgProofpoint' {
    It 'onboard: Ok when present' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith { [pscustomobject]@{ email = 'jdoe@apollon.com' } }
        $r = Confirm-CtgProofpoint -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@apollon.com' }) -Action 'onboard'
        $r.Ok | Should -BeTrue; $r.Present | Should -BeTrue
    }
    It 'offboard: Ok when absent (removed)' {
        Mock Invoke-CtgProofpointApi -ModuleName Coretelligent.Proofpoint -MockWith { param($Method, $Path, $Body, [switch]$AllowFail) $null }
        $r = Confirm-CtgProofpoint -User ([pscustomobject]@{ userToOffboard = 'jdoe@apollon.com' }) -Action 'offboard'
        $r.Ok | Should -BeTrue; $r.Present | Should -BeFalse
    }
}
