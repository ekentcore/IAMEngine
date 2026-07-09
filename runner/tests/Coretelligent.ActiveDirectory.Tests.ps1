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
    function global:Get-ADGroup { [CmdletBinding()] param($Identity, $Properties, $Server, $Credential) }
    function global:Get-ADComputer { [CmdletBinding()] param($Identity, $Filter, $Properties, $Server, $Credential) }
    function global:Get-ADDomain { [CmdletBinding()] param($Server, $Credential) }  # Resolve-CtgAdDomain queries this for the real AD domain

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

    It 'builds the OU DN from the ACTUAL AD domain, not the user email/UPN domain (Six One: AD corp.61commodities.com vs mail 61commodities.com)' {
        # Regression for UM0029655: the DN was built from PrimaryDomain (61commodities.com) so New-ADUser
        # targeted OU=...,DC=61commodities,DC=com — a naming context the DC (corp.61commodities.com) doesn't
        # own -> "The server is unwilling to process the request". The real AD domain must win.
        Mock Get-ADDomain -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DNSRoot='corp.61commodities.com' } }
        $r = Invoke-CtgADOnboarding -User $user -Config ([pscustomobject]@{ ou='Six One Users' })
        $r.Status | Should -Be 'ok'
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter {
            $Path -eq 'OU=Six One Users,DC=corp,DC=61commodities,DC=com'
        }
    }

    It 'falls back to the email domain when the DC domain cannot be queried' {
        Mock Get-ADDomain -ModuleName Coretelligent.ActiveDirectory -MockWith { throw 'no ADWS' }
        $r = Invoke-CtgADOnboarding -User $user -Config ([pscustomobject]@{ ou='Six One Users' })
        Should -Invoke New-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter {
            $Path -eq 'OU=Six One Users,DC=61commodities,DC=com'
        }
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
            @([pscustomobject]@{ Name='Back Office Users'; DistinguishedName='CN=Back Office Users,OU=Groups,DC=x' },
              [pscustomobject]@{ Name='VPN Users'; DistinguishedName='CN=VPN Users,OU=Groups,DC=x' },
              [pscustomobject]@{ Name='Domain Users'; DistinguishedName='CN=Domain Users,CN=Users,DC=x' })
        }
        Mock Set-ADAccountPassword -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
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

    It 'removes a group whose display Name differs from its sAMAccountName (Teams/M365 group) — by DN, not Name' {
        # The bug: Remove-ADGroupMember -Identity $g.Name failed "cannot find an object with identity"
        # for groups whose Name != sAMAccountName (e.g. a Teams group "Chatsoft-Contracts Team_<hex>"),
        # even though the user is a member. Removal must target the DistinguishedName.
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Chatsoft-Contracts Team'; SamAccountName='Chatsoft-Contracts Team_640a4c12864f'; DistinguishedName='CN=Chatsoft-Contracts Team_640a4c12864f,OU=M365 Groups,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Identity -eq 'CN=Chatsoft-Contracts Team_640a4c12864f,OU=M365 Groups,DC=x' }
        ($r.Actions -join ' ') | Should -Match 'removed from group: Chatsoft-Contracts Team'
    }

    It 'offboard rules: removes only the specific rule-named groups the user belongs to (config.removeGroups)' {
        $config = [pscustomobject]@{ disableAccount=$true; removeGroups=@('VPN Users','Nonexistent Group'); guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        # member of 'VPN Users' -> removed by DN; not a member of 'Nonexistent Group' -> skipped
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Identity -eq 'CN=VPN Users,OU=Groups,DC=x' }
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

    It 'does NOT try to remove the primary group (Disabled Users) — keeps it cleanly, no warn' {
        Mock Get-ADGroup -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ Name='Disabled Users'; primaryGroupToken=1234 } }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Properties -contains 'primaryGroupID' } -MockWith { [pscustomobject]@{ primaryGroupID=1234 } }
        # User already in Disabled Users (a prior step / run) AND a normal group.
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Disabled Users'; DistinguishedName='CN=Disabled Users,OU=x,DC=x' },
              [pscustomobject]@{ Name='VPN Users'; DistinguishedName='CN=VPN Users,OU=Groups,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; disabledUsersPrimaryGroup='Disabled Users'; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=Disabled Users,OU=x,DC=x' } -Times 0 -Exactly
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=VPN Users,OU=Groups,DC=x' } -Times 1
        $a = $r.Actions -join ' '
        $a | Should -Match "kept 'Disabled Users' — the user's primary group"
        $a | Should -Not -Match 'could not remove from group Disabled Users'
    }

    It 'sets the Disabled Users group as the primary group before stripping groups' {
        Mock Get-ADGroup -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ Name='Disabled Users'; primaryGroupToken=1234 } }
        # The second Get-ADUser (reading primaryGroupID) returns a different current primary -> a change is made.
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Properties -contains 'primaryGroupID' } -MockWith { [pscustomobject]@{ primaryGroupID=513 } }
        $config = [pscustomobject]@{ disableAccount=$true; removeAllGroups=$true; disabledUsersPrimaryGroup='Disabled Users'; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Members -eq 'jdoe' } -Times 1
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Replace -and $Replace.primaryGroupID -eq 1234 } -Times 1
        ($r.Actions -join ' ') | Should -Match "set 'Disabled Users' as the primary group"
    }

    It 'disables and moves the computer object when disableComputer is set (machine from the case)' {
        Mock Get-ADComputer -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ Name='LT-JDOE'; DistinguishedName='CN=LT-JDOE,OU=Computers,DC=x'; Enabled=$true } }
        $config = [pscustomobject]@{ disableAccount=$true; disableComputer=$true; computerName='LT-JDOE'; disabledComputersOu='OU=Disabled Computers,DC=x'; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Disable-ADAccount -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=LT-JDOE,OU=Computers,DC=x' } -Times 1
        Should -Invoke Move-ADObject -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $TargetPath -eq 'OU=Disabled Computers,DC=x' } -Times 1
        $r.Evidence.Computer.Name | Should -Be 'LT-JDOE'
        ($r.Actions -join ' ') | Should -Match 'disabled computer: LT-JDOE'
    }

    It 'notes when the computer object is not found (no machine in AD)' {
        Mock Get-ADComputer -ModuleName Coretelligent.ActiveDirectory -MockWith { $null }
        $config = [pscustomobject]@{ disableAccount=$true; disableComputer=$true; computerName='GONE-PC'; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        ($r.Actions -join ' ') | Should -Match "computer 'GONE-PC' not found"
    }

    It 'returns a clear message (no crash) when the case has no user identity' {
        $r = Invoke-CtgADOffboarding -User ([pscustomobject]@{ SamAccountName = '' }) -Config ([pscustomobject]@{ disableAccount = $true })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no user identity'
        Should -Invoke Disable-ADAccount -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
    }

    It 'resolves the offboard target by display name when the case has no SamAccountName' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { "$Filter" -match 'DisplayName' } -MockWith { [pscustomobject]@{ SamAccountName = 'jpark'; DistinguishedName = 'CN=Jordan Park,OU=Users,DC=x'; Enabled = $true } }
        $r = Invoke-CtgADOffboarding -User ([pscustomobject]@{ SamAccountName = ''; DisplayName = 'Jordan Park' }) -Config ([pscustomobject]@{ disableAccount = $true; guardrails = @('do-not-move-ou') })
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Jordan Park'"
        Should -Invoke Disable-ADAccount -ModuleName Coretelligent.ActiveDirectory -Times 1
    }

    It 'does not crash when the payload has NO SamAccountName property (display name only)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { "$Filter" -match 'DisplayName' } -MockWith { [pscustomobject]@{ SamAccountName = 'esack'; DistinguishedName = 'CN=Evan,OU=Users,DC=x'; Enabled = $true } }
        # NOTE: the user object intentionally has NO SamAccountName key — direct access would throw under StrictMode.
        $r = Invoke-CtgADOffboarding -User ([pscustomobject]@{ DisplayName = 'Evan Sacksner' }) -Config ([pscustomobject]@{ disableAccount = $true; guardrails = @('do-not-move-ou') })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Evan Sacksner'"
    }

    It 'does NOT remove a well-known privileged group (Domain Admins) — flags it for manual removal' {
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Domain Admins'; DistinguishedName='CN=Domain Admins,CN=Users,DC=x' },
              [pscustomobject]@{ Name='VPN Users'; DistinguishedName='CN=VPN Users,OU=Groups,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=Domain Admins,CN=Users,DC=x' } -Times 0 -Exactly
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=VPN Users,OU=Groups,DC=x' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'protected/privileged group NOT removed.*Domain Admins'
        $r.Evidence.ProtectedGroups | Should -Contain 'Domain Admins'
    }

    It 'does NOT remove a group under a *Privileged* OU (matches the script pattern)' {
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Tier0 Admins'; DistinguishedName='CN=Tier0 Admins,OU=T0 Privileged,OU=Groups,DC=x' },
              [pscustomobject]@{ Name='VPN Users'; DistinguishedName='CN=VPN Users,OU=Groups,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'Tier0 Admins' } -Times 0 -Exactly
        $r.Evidence.ProtectedGroups | Should -Contain 'Tier0 Admins'
    }

    It 'protectPrivilegedGroups:false strips even privileged groups (opt-out)' {
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Domain Admins'; DistinguishedName='CN=Domain Admins,CN=Users,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; protectPrivilegedGroups=$false; disableAccount=$true; guardrails=@('do-not-move-ou') }
        $r = Invoke-CtgADOffboarding -User $user -Config $config
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'CN=Domain Admins,CN=Users,DC=x' } -Times 1
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

    It 'onboard: still validates on an AD WITHOUT the Exchange schema (msExch property errors the call)' {
        # Regression (Six One): the shared read-back requested msExchHideFromAddressLists. On an EXO-only
        # tenant (no on-prem Exchange schema) that fails the WHOLE Get-ADUser call, so a fully-onboarded
        # user validated as ABSENT (all 4 checks failed). The core read-back must not request that attr.
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Laura Munder,OU=SixOneUsers,DC=corp,DC=61commodities,DC=com'; Enabled=$true; HomeDirectory='\\61c-fs01\Users\lauramunder' } }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Properties -contains 'msExchHideFromAddressLists' } -MockWith { throw 'Get-ADUser : One or more properties are invalid.' }
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith { @([pscustomobject]@{ Name='Back Office Users' }) }
        Mock Get-ADDomain -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DNSRoot='corp.61commodities.com' } }
        $user = [pscustomobject]@{ SamAccountName='lauramunder'; PrimaryDomain='61commodities.com' }
        $config = [pscustomobject]@{ ou='SixOneUsers'; groups=@('Back Office Users'); homeDrive=[pscustomobject]@{ unc='\\61c-fs01\Users\<username>'; letter='H' } }
        $r = Confirm-CtgAD -User $user -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'user exists' }).pass | Should -BeTrue
        ($r.checks | Where-Object { $_.name -match 'in OU' }).pass | Should -BeTrue
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

    It 'offboard: a kept privileged group does NOT fail the groups-removed check' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ DistinguishedName='CN=Jane Doe,OU=Six One Users,DC=x'; Enabled=$false } }
        # Only "Domain Admins" (privileged, intentionally kept) + Domain Users remain — must still pass.
        Mock Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith {
            @([pscustomobject]@{ Name='Domain Admins'; DistinguishedName='CN=Domain Admins,CN=Users,DC=x' },
              [pscustomobject]@{ Name='Domain Users'; DistinguishedName='CN=Domain Users,CN=Users,DC=x' })
        }
        $config = [pscustomobject]@{ removeAllGroups=$true; disableAccount=$true; guardrails=@('do-not-move-ou') }
        $r = Confirm-CtgAD -User ([pscustomobject]@{ SamAccountName='jdoe' }) -Config $config -Action 'offboard'
        ($r.checks | Where-Object { $_.name -eq 'groups removed' }).pass | Should -BeTrue
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
