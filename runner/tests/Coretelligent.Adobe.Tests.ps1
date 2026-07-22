#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Adobe. Mocks the action seam (Invoke-CtgAdobeAction). API per the
# Adobe User Management API v2: POST /v2/usermanagement/action/{orgId} with [{user, do:[...]}].

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Adobe/Coretelligent.Adobe.psm1" -Force
}

Describe 'Invoke-CtgAdobeOnboarding' {
    It 'adds the user to each configured product profile' {
        Mock Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -MockWith { [pscustomobject]@{ result = 'success' } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $config = [pscustomobject]@{ productProfiles = @('Acrobat Pro DC', 'Creative Cloud All Apps') }
        $r = Invoke-CtgAdobeOnboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -ParameterFilter {
            $Commands[0].user -eq 'jdoe@61commodities.com' -and ($Commands[0].do[0].add.product -contains 'Acrobat Pro DC')
        } -Times 1
    }

    It 'reports "nothing to grant" (no throw) when no product profiles are configured' {
        # Regression: `@(x) | Where-Object` returns $null when nothing survives, and `$null.Count`
        # THROWS under StrictMode Latest — so an onboard for a client with no productProfiles failed with
        # "The property 'Count' cannot be found on this object" instead of a clean no-op.
        Mock Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -MockWith { throw 'must not call the action seam when nothing to grant' }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@dhm.com' }
        $r = Invoke-CtgAdobeOnboarding -User $user -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no Adobe product profiles configured'
        Should -Invoke Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -Times 0 -Exactly
    }

    It 'reports "nothing to grant" when productProfiles is present but empty' {
        Mock Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -MockWith { throw 'must not call the action seam when nothing to grant' }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@dhm.com' }
        $r = Invoke-CtgAdobeOnboarding -User $user -Config ([pscustomobject]@{ productProfiles = @() })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no Adobe product profiles configured'
    }
}

Describe 'Invoke-CtgAdobeOffboarding' {
    It 'removes the user from the organization' {
        Mock Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -MockWith { [pscustomobject]@{ result = 'success' } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Invoke-CtgAdobeOffboarding -User $user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgAdobeAction -ModuleName Coretelligent.Adobe -ParameterFilter {
            $null -ne $Commands[0].do[0].removeFromOrg
        } -Times 1
        ($r.Actions -join ' ') | Should -Match 'removed .* from the organization'
    }
}

Describe 'Connect-CtgAdobe' {
    It 'requests an IMS client_credentials token' {
        Mock Invoke-RestMethod -ModuleName Coretelligent.Adobe -MockWith { [pscustomobject]@{ access_token = 'tok-a' } }
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        Connect-CtgAdobe -Credential $cred -OrgId '12345@AdobeOrg'
        Should -Invoke Invoke-RestMethod -ModuleName Coretelligent.Adobe -ParameterFilter { $Uri -match 'adobelogin.com' } -Times 1
    }
}

Describe 'Confirm-CtgAdobe' {
    It 'onboard: passes when the user is present in the configured profile' {
        Mock Get-CtgAdobeUser -ModuleName Coretelligent.Adobe -MockWith { [pscustomobject]@{ email = 'jdoe@61commodities.com'; groups = @('Acrobat Pro DC') } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgAdobe -User $user -Config ([pscustomobject]@{ productProfiles = @('Acrobat Pro DC') }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when the user is absent from the org' {
        Mock Get-CtgAdobeUser -ModuleName Coretelligent.Adobe -MockWith { $null }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgAdobe -User $user -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}
