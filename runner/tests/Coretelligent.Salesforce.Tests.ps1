#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Salesforce. Mocks the REST seam (Invoke-CtgSalesforceApi).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Salesforce/Coretelligent.Salesforce.psm1" -Force
    $script:user = [pscustomobject]@{ UserPrincipalName='jane.doe@legalsifter.com'; WorkEmail='jane.doe@legalsifter.com'; FirstName='Jane'; LastName='Doe' }
    $script:cfg  = [pscustomobject]@{ profileId='00e123' }
}

Describe 'Invoke-CtgSalesforceOnboarding' {
    It 'creates a user with the configured profile when none exists' {
        Mock Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/query*') { return [pscustomobject]@{ records = @() } }
            return [pscustomobject]@{ id = '005xx'; success = $true }
        }
        $r = Invoke-CtgSalesforceOnboarding -User $script:user -Config $script:cfg
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/sobjects/User' -and $Body.ProfileId -eq '00e123' } -Times 1
    }

    It 'adopts the existing user (same name) without creating' {
        Mock Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/query*') { return [pscustomobject]@{ records = @([pscustomobject]@{ Id='005a'; Username='jane.doe@legalsifter.com'; FirstName='Jane'; LastName='Doe'; IsActive=$true }) } }
            return $null
        }
        $r = Invoke-CtgSalesforceOnboarding -User $script:user -Config $script:cfg
        Should -Invoke Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'same person'
    }

    It 'throws when no profileId is configured (cannot create)' {
        Mock Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -MockWith { param($Method, $Path) if ($Path -like '/query*') { [pscustomobject]@{ records = @() } } }
        { Invoke-CtgSalesforceOnboarding -User $script:user -Config ([pscustomobject]@{}) } | Should -Throw -ExpectedMessage '*profileId*'
    }
}

Describe 'Invoke-CtgSalesforceOffboarding' {
    It 'deactivates (IsActive=false), never deletes' {
        Mock Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/query*') { return [pscustomobject]@{ records = @([pscustomobject]@{ Id='005a'; IsActive=$true }) } }
            return $null
        }
        $r = Invoke-CtgSalesforceOffboarding -User $script:user -Config $script:cfg
        Should -Invoke Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -ParameterFilter { $Method -eq 'PATCH' -and $Body.IsActive -eq $false } -Times 1
        Should -Invoke Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
    }
}

Describe 'Confirm-CtgSalesforce' {
    It 'onboard: passes when present and active' {
        Mock Invoke-CtgSalesforceApi -ModuleName Coretelligent.Salesforce -MockWith { [pscustomobject]@{ records = @([pscustomobject]@{ Id='005a'; IsActive=$true }) } }
        (Confirm-CtgSalesforce -User $script:user -Config $script:cfg -Action 'onboard').ok | Should -BeTrue
    }
}
