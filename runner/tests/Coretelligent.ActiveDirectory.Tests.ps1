#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.ActiveDirectory. The on-prem ActiveDirectory cmdlets aren't
# installed here, so we stub them globally and Mock in the module scope. Focus: OU placement,
# conditional groups, evidence-before-removal, and the do-not-move-ou guardrail (Six One).

BeforeAll {
    $ModulePath = "$PSScriptRoot/../modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1"

    # Param blocks so Pester -ParameterFilter can see the bound args (e.g. $Path, $HomeDrive).
    # CmdletBinding gives -ErrorAction etc. for free; SupportsShouldProcess accepts -Confirm.
    # All stubs accept $Server/$Credential — the module splats @AdConnection (brokered ad-dc auth) onto every cmdlet.
    function global:Get-ADUser { [CmdletBinding()] param($Filter, $Identity, $Properties, $Server, $Credential) }
    function global:New-ADUser { [CmdletBinding()] param($Name, $SamAccountName, $UserPrincipalName, $GivenName, $Surname, $DisplayName, $Path, $Enabled, $OtherAttributes, $AccountPassword, $Server, $Credential) }
    function global:Set-ADUser { [CmdletBinding()] param($Identity, $HomeDrive, $HomeDirectory, $Replace, $Clear, $Add, $Remove, $Manager, $Server, $Credential) }
    function global:Add-ADGroupMember { [CmdletBinding()] param($Identity, $Members, $Server, $Credential) }
    function global:Remove-ADGroupMember { [CmdletBinding(SupportsShouldProcess)] param($Identity, $Members, $Server, $Credential) }
    function global:Get-ADPrincipalGroupMembership { [CmdletBinding()] param($Identity, $Server, $Credential) }
    function global:Disable-ADAccount { [CmdletBinding()] param($Identity, $Server, $Credential) }
    function global:Move-ADObject { [CmdletBinding()] param($Identity, $TargetPath, $Server, $Credential) }
    function global:Set-ADAccountPassword { [CmdletBinding()] param($Identity, [switch]$Reset, $NewPassword, $Server, $Credential) }

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

    It 'adopts an existing account whose NAME matches (same person, re-run) without creating' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ SamAccountName='jdoe'; GivenName='Jane'; Surname='Doe'; DisplayName='Jane Doe' } }
        $r = Invoke-CtgADOnboarding -User $user -Config ([pscustomobject]@{ ou='Six One Users' })
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'same person'
    }

    It 'uses a FALLBACK SamAccountName when the primary is taken by a different person' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Filter -match "'jdoe'" } -MockWith { [pscustomobject]@{ SamAccountName='jdoe'; GivenName='John'; Surname='Doe'; DisplayName='John Doe' } }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Filter -match "'jane.doe'" } -MockWith { $null }
        $u = $user | Select-Object *; $u | Add-Member UserPrincipalNameFallbacks @('jane.doe@61commodities.com') -Force
        $r = Invoke-CtgADOnboarding -User $u -Config ([pscustomobject]@{ ou='Six One Users' })
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $SamAccountName -eq 'jane.doe' -and $UserPrincipalName -eq 'jane.doe@61commodities.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'fallback username'
    }

    It 'PAUSES for a decision when the only username is taken by a different person' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ SamAccountName='jdoe'; GivenName='John'; Surname='Doe'; DisplayName='John Doe' } }
        { Invoke-CtgADOnboarding -User $user -Config ([pscustomobject]@{ ou='Six One Users' }) } | Should -Throw -ExpectedMessage '*DECISION_NEEDED:username_collision*'
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

    It 'mirrors the reference user''s live groups (union with base groups)' {
        # New user absent (SamAccountName filter -> $null); the mirror reference resolves with 2 groups.
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {
            if ($Filter -like '*Christine Holleran*') {
                [pscustomobject]@{ MemberOf = @('CN=Finance-Team,OU=Groups,DC=x', 'CN=VPN-Users,OU=Groups,DC=x') }
            } else { $null }
        }
        $config = [pscustomobject]@{ ou='Finance'; groups=@('DEPT-Finance'); mirrorFromUser='Christine Holleran' }
        $r = Invoke-CtgADOnboarding -User $user -Config $config
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'DEPT-Finance' } -Times 1
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=Finance-Team,OU=Groups,DC=x' } -Times 1
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=VPN-Users,OU=Groups,DC=x' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'mirrored 2 group'
    }

    It 'threads the brokered ad-dc connection (Server + Credential) onto AD cmdlets' {
        $cred = [pscredential]::new('CORE\svc-ad', (ConvertTo-SecureString 'p' -AsPlainText -Force))
        $config = [pscustomobject]@{ ou='Finance'; groups=@('DEPT-Finance'); attributes=[pscustomobject]@{ title='Analyst' } }
        $r = Invoke-CtgADOnboarding -User $user -Config $config -AdConnection @{ Server='core-cce-dc01'; Credential=$cred }
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Server -eq 'core-cce-dc01' -and $Credential -eq $cred } -Times 1
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Server -eq 'core-cce-dc01' -and $Credential } -Times 1
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Server -eq 'core-cce-dc01' } -Times 1  # attribute set
    }

    It 'flags a missing mirror user without failing the onboard' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { $null } # nobody matches
        $config = [pscustomobject]@{ ou='Finance'; groups=@('DEPT-Finance'); mirrorFromUser='Nobody Here' }
        $r = Invoke-CtgADOnboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match "mirror user 'Nobody Here' not found"
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

    It 'offboard rules: removes only the specific rule-named groups the user belongs to (config.removeGroups)' {
        $config = [pscustomobject]@{ disableAccount=$true; removeGroups=@('VPN Users','Nonexistent Group'); guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        # member of 'VPN Users' -> removed; not a member of 'Nonexistent Group' -> skipped
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Identity -eq 'VPN Users' }
        ($r.Actions -join ' ') | Should -Match 'not a member of Nonexistent Group'
    }

    It 'offboard rules: moveToOu wins over the system default disabledUsersOu' {
        $config = [pscustomobject]@{ disableAccount=$true; moveToOu='OU=Rule Disabled,DC=x'; disabledUsersOu='OU=Default Disabled,DC=x' }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Move-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $TargetPath -eq 'OU=Rule Disabled,DC=x' }
    }

    It 'offboard rules: sets offboard attributes (config.offboardAttributes)' {
        $config = [pscustomobject]@{ disableAccount=$true; offboardAttributes=[pscustomobject]@{ description='Offboarded' }; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Replace -and $Replace.description -eq 'Offboarded' }
        ($r.Actions -join ' ') | Should -Match 'description=Offboarded'
    }
}

Describe 'Confirm-CtgAD' {
    It 'onboard: passes when the user is in the OU with the expected group' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Jane Doe,OU=Six One Users,DC=61commodities,DC=com'; Enabled=$true; HomeDirectory='\\srv\home\jdoe' } }
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith { @([pscustomobject]@{ Name='Back Office Users' }, [pscustomobject]@{ Name='Domain Users' }) }
        $user = [pscustomobject]@{ SamAccountName='jdoe'; PrimaryDomain='61commodities.com' }
        $config = [pscustomobject]@{ ou='Six One Users'; groups=@('Back Office Users'); homeDrive=[pscustomobject]@{ unc='\\srv\home\<username>'; letter='H' } }
        $r = Confirm-CtgAD -User $user -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'group: Back Office Users' }).pass | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'home drive mapped' }).pass | Should -BeTrue
    }

    It 'offboard: passes when disabled, groups gone, hidden, and NOT moved (guardrail)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Jane Doe,OU=Six One Users,DC=x'; Enabled=$false; msExchHideFromAddressLists=$true } }
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith { @([pscustomobject]@{ Name='Domain Users' }) }
        $user = [pscustomobject]@{ SamAccountName='jdoe' }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; hideFromGal=[pscustomobject]@{ attribute='msExchHideFromAddressLists' }; guardrails=@('do-not-move-ou'); disabledUsersOu='OU=Disabled,DC=x' }
        $r = Confirm-CtgAD -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'not moved (do-not-move-ou)' }).pass | Should -BeTrue
    }

    It 'offboard: fails the not-moved check when the user sits under the Disabled OU' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Jane Doe,OU=Disabled,DC=x'; Enabled=$false } }
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith { @() }
        $user = [pscustomobject]@{ SamAccountName='jdoe' }
        $config = [pscustomobject]@{ disableAccount=$true; guardrails=@('do-not-move-ou'); disabledUsersOu='OU=Disabled,DC=x' }
        $r = Confirm-CtgAD -User $user -Config $config -Action 'offboard'
        ($r.checks | Where-Object { $_.name -eq 'not moved (do-not-move-ou)' }).pass | Should -BeFalse
    }
}

Describe 'Set-CtgADAttributes' {
    It 'Set-ADUser -Replace each non-empty attribute' {
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        $applied = Set-CtgADAttributes -Identity 'jdoe' -Attributes @{ title='Engineer'; department='Field Services'; c='US' }
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 3
        ($applied -join '|') | Should -Match 'title=Engineer'
    }

    It 'skips empty / null values' {
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        $applied = Set-CtgADAttributes -Identity 'jdoe' -Attributes @{ title=''; st=$null; department='X' }
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1
        ($applied -join '|') | Should -Not -Match 'title'
    }

    It 'resolves a manager NAME to a DN and sets -Manager' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Jane Boss,OU=Users,DC=x' } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        Set-CtgADAttributes -Identity 'jdoe' -Attributes @{ manager='Jane Boss' }
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Manager -eq 'CN=Jane Boss,OU=Users,DC=x' } -Times 1
    }

    It 'uses a manager DN as-is (no lookup)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        Set-CtgADAttributes -Identity 'jdoe' -Attributes @{ manager='CN=Boss,OU=Users,DC=x' }
        Should -Invoke Get-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Manager -eq 'CN=Boss,OU=Users,DC=x' } -Times 1
    }

    It 'onboarding applies the resolved attribute map' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { $null }
        Mock New-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        Mock Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith {}
        $user = [pscustomobject]@{ SamAccountName='jdoe'; DisplayName='John Doe'; FirstName='John'; LastName='Doe'; UserPrincipalName='jdoe@core.tech'; PrimaryDomain='core.tech' }
        $config = [pscustomobject]@{ ou='OU=Field,DC=x'; attributes=[pscustomobject]@{ title='Engineer'; department='Field Services' } }
        $r = Invoke-CtgADOnboarding -User $user -Config $config
        ($r.Actions -join '|') | Should -Match 'set attribute: title=Engineer'
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Replace -and $Replace.department -eq 'Field Services' } -Times 1
    }
}
