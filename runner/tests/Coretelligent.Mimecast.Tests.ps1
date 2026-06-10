#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Mimecast. We mock the single HTTP seam (Invoke-CtgMimecastApi)
# so no live tenant is needed. Endpoints are the classic set served by API 2.0 with Bearer auth:
#   POST /api/directory/get-connection / execute-sync
#   POST /api/user/get-profile (fail[] = user unknown) / create-user
#   POST /api/directory/find-groups / remove-group-member / get-group-members
# The seam returns the response's data ARRAY (or the raw envelope with -AllowFail).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psm1" -Force
}

Describe 'Invoke-CtgMimecastOnboarding' {
    It 'verifies a sync connection exists, triggers a sync, and sees the user' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @([pscustomobject]@{ name = 'AzureAD sync' }) }
                '*get-profile*'    { return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/execute-sync' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'Mimecast user present'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' } -Times 0 -Exactly
    }

    It 'creates a cloud user when missing and createIfMissing is set' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @() }
                '*get-profile*'    { return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_user_not_found'; message = 'unknown user' }) }); data = @() } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'new@drakestar.com'; DisplayName = 'New Hire' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{ createIfMissing = $true }) -InitialPassword 'Xx!long-password-1'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' -and $Data.emailAddress -eq 'new@drakestar.com' -and $Data.forcePasswordChange -eq $true } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Mimecast cloud user'
    }

    It 'notes (not creates) when the user is missing and createIfMissing is off' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @([pscustomobject]@{ name = 'AD sync' }) }
                '*get-profile*'    { return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @() }); data = @() } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'new@drakestar.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not visible yet'
    }

    It 'warns when no sync connection exists and createIfMissing is off' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*get-profile*') { return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) } }
            return @()
        }
        $r = Invoke-CtgMimecastOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{})
        ($r.Actions -join ' ') | Should -Match 'WARN no directory-sync connection'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/execute-sync' } -Times 0 -Exactly
    }
}

Describe 'Invoke-CtgMimecastOffboarding' {
    It 'resolves group names and removes the user' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*find-groups*') { return @([pscustomobject]@{ id = 'AAAAAAAAAAAAAAAAAAAAAAAAAA'; description = 'All Staff' }) }
            return @()
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }
        $r = Invoke-CtgMimecastOffboarding -User $user -Config ([pscustomobject]@{ groups = @('All Staff') })
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/remove-group-member' -and $Data.emailAddress -eq 'jdoe@drakestar.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'removed from Mimecast group'
    }

    It 'no-ops cleanly with no configured groups' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith { @() }
        $r = Invoke-CtgMimecastOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no Mimecast group removals configured'
    }
}

Describe 'Confirm-CtgMimecast' {
    It 'onboard: passes when the user profile is visible' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) }
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: fails when the user is not visible yet' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @() }); data = @() }
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'new@drakestar.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when the user is absent from the configured groups' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*find-groups*') { return @([pscustomobject]@{ id = 'BBBBBBBBBBBBBBBBBBBBBBBBBB'; description = 'All Staff' }) }
            return @()   # get-group-members: empty
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{ groups = @('All Staff') }) -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}
