#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.ActiveDirectory. The on-prem ActiveDirectory cmdlets aren't
# installed here, so we stub them globally and Mock in the module scope. Focus: OU placement,
# conditional groups, evidence-before-removal, and the do-not-move-ou guardrail (Six One).

BeforeAll {
    $ModulePath = "$PSScriptRoot/../modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1"

    # Param blocks so Pester -ParameterFilter can see the bound args (e.g. $Path, $HomeDrive).
    # CmdletBinding gives -ErrorAction etc. for free; SupportsShouldProcess accepts -Confirm.
    function global:Get-ADUser { [CmdletBinding()] param($Filter, $Identity, $Properties) }
    function global:New-ADUser { [CmdletBinding()] param($Name, $SamAccountName, $UserPrincipalName, $GivenName, $Surname, $DisplayName, $Path, $Enabled, $OtherAttributes, $AccountPassword) }
    function global:Set-ADUser { [CmdletBinding()] param($Identity, $HomeDrive, $HomeDirectory, $Replace, $Clear, $Add, $Remove, $Manager) }
    function global:Add-ADGroupMember { [CmdletBinding()] param($Identity, $Members) }
    function global:Remove-ADGroupMember { [CmdletBinding(SupportsShouldProcess)] param($Identity, $Members) }
    function global:Get-ADPrincipalGroupMembership { [CmdletBinding()] param($Identity) }
    function global:Disable-ADAccount { [CmdletBinding()] param($Identity) }
    function global:Move-ADObject { [CmdletBinding()] param($Identity, $TargetPath) }
    function global:Set-ADAccountPassword { [CmdletBinding()] param($Identity, [switch]$Reset, $NewPassword) }

    Import-Module $ModulePath -Force
}

Describe 'Invoke-CtgADOnboarding' {
    BeforeEach {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { $null }   # user absent
        Mock New-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        $user = [pscustomobject]@{ SamAccountName='jdoe'; FirstName='Jane'; LastName='Doe'; DisplayName='Jane Doe'; UserPrincipalName='jdoe@61commodities.com'; PrimaryDomain='61commodities.com' }
    }

    It 'creates the user in the configured OU when absent' {
        $config = [pscustomobject]@{ ou='Six One Users'; groups=@('Back Office Users') }
        $r = Invoke-CtgADOnboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Path -match 'Six One Users' }
    }

    It 'adds base groups and conditional groups only when their condition holds' {
        $config = [pscustomobject]@{
            ou='Six One Users'; groups=@('Back Office Users')
            conditionalGroups=@(
                [pscustomobject]@{ when='avd == true'; groups=@('61C-CORE_Users') }
                [pscustomobject]@{ when='perimeter == true'; groups=@('Perimeter 81 requested groups') }
            )
        }
        $withAvd = $user | Select-Object *; $withAvd | Add-Member avd $true -Force
        $r = Invoke-CtgADOnboarding -User $withAvd -Config $config
        # Back Office Users + 61C-CORE_Users (avd true); Perimeter NOT added (perimeter not set)
        ($r.Actions -join ' ') | Should -Match 'Back Office Users'
        ($r.Actions -join ' ') | Should -Match '61C-CORE_Users'
        ($r.Actions -join ' ') | Should -Not -Match 'Perimeter 81 requested groups'
    }

    It 'maps the home drive when configured' {
        $config = [pscustomobject]@{ ou='Six One Users'; homeDrive=[pscustomobject]@{ letter='H'; unc='\\61c-fs01\Users\<username>' } }
        $r = Invoke-CtgADOnboarding -User $user -Config $config
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $HomeDrive -eq 'H:' -and $HomeDirectory -match 'jdoe' }
    }
}

Describe 'Invoke-CtgADOffboarding' {
    BeforeEach {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {
            [pscustomobject]@{ SamAccountName='jdoe'; DistinguishedName='CN=Jane Doe,OU=Six One Users,DC=x'; Enabled=$true }
        }
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Back Office Users' }, [pscustomobject]@{ Name='VPN Users' }, [pscustomobject]@{ Name='Domain Users' })
        }
        Mock Set-ADAccountPassword -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Disable-ADAccount -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Move-ADObject -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        $user = [pscustomobject]@{ SamAccountName='jdoe' }
    }

    It 'captures group evidence, removes groups (except primary), hides from GAL, and disables' {
        $config = [pscustomobject]@{
            resetPassword=$true; removeAllGroups=$true; disableAccount=$true
            hideFromGal=[pscustomobject]@{ attribute='msDS-cloudExtensionAttribute1'; value='HideFromGAL' }
            guardrails=@('do-not-move-ou')
        }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        $r.Evidence.Groups | Should -Contain 'Back Office Users'
        # Domain Users (primary group) must not be removed
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 2 -Exactly
        Should -Invoke Disable-ADAccount -ModuleName Coretelligent.ActiveDirectory -Times 1
        ($r.Actions -join ' ') | Should -Match 'HideFromGAL'
    }

    It 'does NOT move the user OU when the do-not-move-ou guardrail is set (the 365-delete trap)' {
        $config = [pscustomobject]@{ disableAccount=$true; guardrails=@('do-not-move-ou'); disabledUsersOu='OU=Disabled,DC=x' }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Move-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'did not move'
    }

    It 'moves the user to the Disabled Users OU when no guardrail blocks it' {
        $config = [pscustomobject]@{ disableAccount=$true; disabledUsersOu='OU=Disabled Users,DC=x' }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Move-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $TargetPath -match 'Disabled Users' }
    }
}
