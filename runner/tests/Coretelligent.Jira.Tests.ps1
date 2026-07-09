#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Jira. Mocks the REST seam (Invoke-CtgJiraApi).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Jira/Coretelligent.Jira.psm1" -Force
    $script:user = [pscustomobject]@{ UserPrincipalName='jane.doe@legalsifter.com'; WorkEmail='jane.doe@legalsifter.com'; FirstName='Jane'; LastName='Doe' }
}

Describe 'Invoke-CtgJiraOnboarding' {
    It 'creates a user with the configured products when none exists' {
        Mock Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/rest/api/3/user/search*') { return @() }
            return [pscustomobject]@{ accountId = 'abc' }
        }
        $r = Invoke-CtgJiraOnboarding -User $script:user -Config ([pscustomobject]@{ products=@('jira-software') })
        Should -Invoke Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/rest/api/3/user' -and $Body.emailAddress -eq 'jane.doe@legalsifter.com' -and ($Body.products -contains 'jira-software') } -Times 1
    }

    It 'is idempotent — adopts the existing email without creating' {
        Mock Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return @([pscustomobject]@{ accountId='abc'; emailAddress='jane.doe@legalsifter.com' }) }
            return $null
        }
        $r = Invoke-CtgJiraOnboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }
}

Describe 'Invoke-CtgJiraOffboarding' {
    It 'removes the user from the site by accountId' {
        Mock Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return @([pscustomobject]@{ accountId='abc'; emailAddress='jane.doe@legalsifter.com' }) }
            return $null
        }
        $r = Invoke-CtgJiraOffboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgJiraApi -ModuleName Coretelligent.Jira -ParameterFilter { $Method -eq 'DELETE' -and $Path -like '*accountId=abc*' } -Times 1
    }
}
