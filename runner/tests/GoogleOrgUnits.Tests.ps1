# FR #0000081: the tenant's Google OU paths, for the app's OU pickers.
BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1" -Force -DisableNameChecking
}
AfterAll { Remove-Module Coretelligent.GoogleWorkspace -Force -ErrorAction SilentlyContinue }

Describe 'Get-CtgGoogleOrgUnits' {
    It 'lists every OU path once, sorted, without the root, from one orgunits?type=all call' {
        InModuleScope Coretelligent.GoogleWorkspace {
            Mock Get-CtgGoogleCustomer { 'C0abc123' }
            Mock Invoke-CtgGoogleApi {
                [pscustomobject]@{ organizationUnits = @(
                    [pscustomobject]@{ orgUnitPath = '/Staff/Sales' },
                    [pscustomobject]@{ orgUnitPath = '/' },
                    [pscustomobject]@{ orgUnitPath = '/Active Users' },
                    [pscustomobject]@{ orgUnitPath = '/Staff/Sales' }
                ) }
            }
            $ous = Get-CtgGoogleOrgUnits
            $ous | Should -Be @('/Active Users', '/Staff/Sales')
            Should -Invoke Invoke-CtgGoogleApi -Times 1 -Exactly -ParameterFilter { $Method -eq 'GET' -and $Path -eq '/customer/C0abc123/orgunits?type=all' }
        }
    }
    It 'returns an empty list for a tenant with no sub-OUs' {
        InModuleScope Coretelligent.GoogleWorkspace {
            Mock Get-CtgGoogleCustomer { 'my_customer' }
            Mock Invoke-CtgGoogleApi { [pscustomobject]@{ } }
            @(Get-CtgGoogleOrgUnits).Count | Should -Be 0
        }
    }
}
