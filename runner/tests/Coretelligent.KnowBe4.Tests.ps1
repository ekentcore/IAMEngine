#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.KnowBe4. Mocks the SCIM seam (Invoke-CtgKnowBe4Scim).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.KnowBe4/Coretelligent.KnowBe4.psm1" -Force
    $script:user = [pscustomobject]@{ UserPrincipalName='jane.doe@legalsifter.com'; WorkEmail='jane.doe@legalsifter.com'; FirstName='Jane'; LastName='Doe' }
}

Describe 'Invoke-CtgKnowBe4Onboarding' {
    It 'creates a SCIM user when none exists' {
        Mock Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/Users*') { return [pscustomobject]@{ Resources = @() } }
            return [pscustomobject]@{ id = '1' }
        }
        $r = Invoke-CtgKnowBe4Onboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/Users' -and $Body.userName -eq 'jane.doe@legalsifter.com' -and $Body.active -eq $true } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created KnowBe4 user'
    }

    It 'adopts an existing SCIM user with a matching name (no create)' {
        Mock Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/Users*') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id='1'; name=@{ givenName='Jane'; familyName='Doe' }; active=$true }) } }
            return $null
        }
        $r = Invoke-CtgKnowBe4Onboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'same person'
    }
}

Describe 'Invoke-CtgKnowBe4Offboarding' {
    It 'deactivates via SCIM PATCH (active=false)' {
        Mock Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id='1'; active=$true }) } }
            return $null
        }
        $r = Invoke-CtgKnowBe4Offboarding -User $script:user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgKnowBe4Scim -ModuleName Coretelligent.KnowBe4 -ParameterFilter { $Method -eq 'PATCH' -and $Path -eq '/Users/1' } -Times 1
    }
}
