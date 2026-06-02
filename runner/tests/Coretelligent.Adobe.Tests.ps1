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
