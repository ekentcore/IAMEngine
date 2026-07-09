#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.HubSpot. Mocks the REST seam (Invoke-CtgHubSpotApi).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.HubSpot/Coretelligent.HubSpot.psm1" -Force
    $script:user = [pscustomobject]@{ UserPrincipalName='jane.doe@legalsifter.com'; WorkEmail='jane.doe@legalsifter.com'; FirstName='Jane'; LastName='Doe' }
}

Describe 'Invoke-CtgHubSpotOnboarding' {
    It 'creates a user with the configured role when none exists' {
        Mock Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return $null }   # 404 -> not found
            return [pscustomobject]@{ id = '99'; email = 'jane.doe@legalsifter.com' }
        }
        $r = Invoke-CtgHubSpotOnboarding -User $script:user -Config ([pscustomobject]@{ roleId='12345' })
        Should -Invoke Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/settings/v3/users' -and $Body.email -eq 'jane.doe@legalsifter.com' -and $Body.roleId -eq '12345' } -Times 1
    }

    It 'is idempotent — adopts the existing email without creating' {
        Mock Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id='99'; email='jane.doe@legalsifter.com' } }
            return $null
        }
        $r = Invoke-CtgHubSpotOnboarding -User $script:user -Config ([pscustomobject]@{ roleId='12345' })
        Should -Invoke Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }
}

Describe 'Invoke-CtgHubSpotOffboarding' {
    It 'removes the user by email' {
        Mock Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ id='99'; email='jane.doe@legalsifter.com' } }
            return $null
        }
        $r = Invoke-CtgHubSpotOffboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgHubSpotApi -ModuleName Coretelligent.HubSpot -ParameterFilter { $Method -eq 'DELETE' -and $Path -like '/settings/v3/users/*idProperty=EMAIL*' } -Times 1
    }
}
