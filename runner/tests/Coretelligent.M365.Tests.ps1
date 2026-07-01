#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.M365. The Microsoft.Graph cmdlets aren't installed here, so
# we declare thin stubs (BeforeAll) and Mock them in the module scope to assert behavior:
# license-name -> SkuId resolution, idempotent onboarding, and the offboarding branch logic.

BeforeAll {
    # Import the implementation directly so the manifest's RequiredModules (Microsoft.Graph,
    # not installed in CI) don't block unit tests; the Graph cmdlets are mocked below.
    $ModulePath = "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psm1"

    # Global stubs so Pester can Mock these in the module scope (real cmdlets come from Microsoft.Graph).
    function global:Get-MgSubscribedSku { param($SubscribedSkuId, [switch]$All) }
    function global:Get-MgUser { param($UserId, $Filter, [switch]$All, $ConsistencyLevel) }
    function global:New-MgUser {}
    function global:Get-MgUserLicenseDetail {}
    function global:Set-MgUserLicense { param($UserId, $AddLicenses, $RemoveLicenses) }
    function global:Get-MgGroup {}
    function global:Get-MgGroupMember {}
    function global:New-MgGroupMember { param($GroupId, $DirectoryObjectId) }
    function global:Update-MgUser { param($UserId, $Department, $OfficeLocation, $JobTitle, $MobilePhone, $CompanyName, $StreetAddress, $City, $State, $PostalCode, $Country, $BusinessPhones, $OnPremisesExtensionAttributes, $AccountEnabled, $ProxyAddresses) }
    function global:Set-MgUserManagerByRef { param($UserId, $BodyParameter) }
    function global:Get-MgUserMemberOf { param($UserId, [switch]$All) }
    function global:Remove-MgGroupMemberByRef { param($GroupId, $DirectoryObjectId) }
    function global:Get-MgUserDefaultDrive {}
    function global:Revoke-MgUserSignInSession { param($UserId) }
    function global:Get-MgUserRegisteredDevice { param($UserId, [switch]$All) }
    function global:Update-MgDevice { param($DeviceId, $AccountEnabled) }
    function global:Get-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId) }
    function global:New-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId, $BodyParameter) }
    function global:Remove-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId, $TemporaryAccessPassAuthenticationMethodId) }

    Import-Module $ModulePath -Force

    $script:Skus = @(
        [pscustomobject]@{ SkuId = 'sku-e3'; SkuPartNumber = 'SPE_E3' }
        [pscustomobject]@{ SkuId = 'sku-p2'; SkuPartNumber = 'AAD_PREMIUM_P2' }
    )
}

Describe 'Resolve-CtgSkuId' {
    BeforeAll {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:Skus }
    }
    It 'resolves a friendly license name to its SkuId' {
        InModuleScope Coretelligent.M365 { Resolve-CtgSkuId 'Microsoft 365 E3' } | Should -Be 'sku-e3'
    }
    It 'resolves a raw SkuPartNumber directly' {
        InModuleScope Coretelligent.M365 { Resolve-CtgSkuId 'AAD_PREMIUM_P2' } | Should -Be 'sku-p2'
    }
    It 'passes through an explicit skuId object unchanged' {
        InModuleScope Coretelligent.M365 { Resolve-CtgSkuId ([pscustomobject]@{ name = 'x'; skuId = 'sku-explicit' }) } | Should -Be 'sku-explicit'
    }
    It 'returns $null for a license the tenant does not have' {
        InModuleScope Coretelligent.M365 { Resolve-CtgSkuId 'Nonexistent SKU' } | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-CtgM365Onboarding' {
    BeforeEach {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:Skus }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }   # user does not exist yet
        Mock New-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1' } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ SkuId = 'sku-e3' }) } # E3 already present
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'grp-1' } }
        Mock Get-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { }
    }

    It 'uses the fallback username when the primary UPN is taken by a DIFFERENT person' {
        # Primary jdoe@x.com is taken by John Doe (a different person); fallback j.doe@x.com is free.
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') { return [pscustomobject]@{ Id = 'other'; DisplayName = 'John Doe' } }
            return $null
        }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd
        $r.Status | Should -Be 'ok'
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match "taken by a different user"
        ($r.Actions -join ' ') | Should -Match 'fallback username: j.doe@x.com'
        $r.Upn | Should -Be 'j.doe@x.com'
    }

    It 'reuses the existing user (no create) when the primary UPN carries OUR provisioning marker (re-run)' {
        # marker = personalEmail when present; the existing account's extensionAttribute1 must match it.
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-jane'; DisplayName = 'Jane Doe'; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = 'jane.personal@gmail.com' } } }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane.personal@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'our account .re-run., skipped create'
    }

    It 'PAUSES for a decision on an ambiguous same-name no-marker account (no policy = ask)' {
        # Same display name, NO marker, and no operator decision yet -> throw DECISION_NEEDED, create nothing.
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') { return [pscustomobject]@{ Id = 'uid-jane'; DisplayName = 'Jane Doe'; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = $null } } }
            return $null
        }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd } | Should -Throw -ExpectedMessage '*DECISION_NEEDED:username_collision*'
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'ADOPTS the same-name no-marker account when the operator chose adopt (usernameCollisionPolicy=adopt)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') { return [pscustomobject]@{ Id = 'uid-jane'; DisplayName = 'Jane Doe'; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = $null } } }
            return $null
        }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith {}
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ usernameCollisionPolicy = 'adopt' }) -InitialPassword $pwd
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        $r.Upn | Should -Be 'jdoe@x.com'
        ($r.Actions -join ' ') | Should -Match 'operator chose ADOPT'
    }

    It 'uses the fallback when the primary UPN is taken by a DIFFERENT person (different name, no marker)' {
        # jdoe@x.com exists as "John Smith" with no marker -> NOT our user -> create with the fallback.
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') { return [pscustomobject]@{ Id = 'stranger'; DisplayName = 'John Smith'; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = $null } } }
            return $null
        }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane.new@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{}) -InitialPassword $pwd
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
        $r.Upn | Should -Be 'j.doe@x.com'
    }

    It 'reads Config.licenses (name strings), assigning only the missing SkuIds' {
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone=''; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @('Microsoft 365 E3', 'Microsoft Entra ID P2'); groups = @('Back Office Users') }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force

        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        $r.Status | Should -Be 'ok'
        # E3 already present -> not re-added; P2 missing -> added once
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'assigned license: Microsoft Entra ID P2'
        ($r.Actions -join ' ') | Should -Match 'license present'
    }

    It 'adds the user to Config.groups when not already a member' {
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('Back Office Users') }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 1 -Exactly
    }

    It 'writes profile attributes (department, office location, address) from the intake' {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone='+15551234567'; UsageLocation='US'; Department='Engineering'; OfficeLocation='Boston'; HomeAddress='1 Main St' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        Invoke-CtgM365Onboarding -User $u -Config ([pscustomobject]@{ licenses = @() }) -InitialPassword $pwd | Out-Null
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Department -eq 'Engineering' -and $OfficeLocation -eq 'Boston' -and $StreetAddress -eq '1 Main St' } -Times 1
    }

    It 'sets the manager, resolving a SNOW "First (Nick) Last" to the 365 "Nick Last"' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($Filter -like "*Jim Goodmiller*") { return [pscustomobject]@{ Id = 'mgr-1'; DisplayName = 'Jim Goodmiller' } }
            return $null  # the new user doesn't exist yet
        }
        Mock Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone=''; UsageLocation='US'; ManagerName='James (Jim) Goodmiller' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $u -Config ([pscustomobject]@{ licenses = @() }) -InitialPassword $pwd
        Should -Invoke Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -ParameterFilter { $BodyParameter['@odata.id'] -like '*mgr-1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'set manager: Jim Goodmiller'
    }

    It 'sets the manager by EMAIL when the intake resolved one (stable across SNOW/365)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($Filter -like "*mail eq 'jim.goodmiller@x.com'*") { return [pscustomobject]@{ Id = 'mgr-9'; DisplayName = 'Jim Goodmiller' } }
            return $null
        }
        Mock Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone=''; UsageLocation='US'; ManagerName='James (Jim) Goodmiller'; ManagerEmail='jim.goodmiller@x.com' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        Invoke-CtgM365Onboarding -User $u -Config ([pscustomobject]@{ licenses = @() }) -InitialPassword $pwd | Out-Null
        Should -Invoke Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -ParameterFilter { $BodyParameter['@odata.id'] -like '*mgr-9' } -Times 1
    }

    It 'skips a DYNAMIC group (membership is rule-computed) without adding or warning' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'grp-dyn'; SecurityEnabled = $true; GroupTypes = @('DynamicMembership') } }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone=''; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('All Users') }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 0 -Exactly   # never added manually
        ($r.Actions -join ' ') | Should -Match 'skipped dynamic group'
        $r.Status | Should -Be 'ok'   # not a warning — nothing to do
    }

    It 'leaves the user unlicensed with a Procurement warning when a license has no available seats' {
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }   # no licenses yet
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { throw "Subscription with SKU cbdc14ab does not have any available licenses." }
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle='Analyst'; MobilePhone=''; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @('Microsoft 365 E3'); groups = @() }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        $r.Status | Should -Be 'ok'   # warning, not a failure
        ($r.Actions -join ' ') | Should -Match "no available 'Microsoft 365 E3' license seats"
        ($r.Actions -join ' ') | Should -Match 'Procurement Case'
    }

    It 'omits a blank / unresolved job title on create (Graph rejects empty values)' {
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone='{token}'; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @(); groups = @() }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no job title'
    }
}

Describe 'Invoke-CtgM365Offboarding' {
    BeforeEach {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ Id = 'grp-1'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Sales' } }
                [pscustomobject]@{ Id = 'grp-2'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'VPN' } }
            )
        }
        Mock Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { }
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ SkuId = 'sku-e3' }) }
        Mock Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserRegisteredDevice -ModuleName Coretelligent.M365 -MockWith {
            @([pscustomobject]@{ Id = 'dev-1'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.device'; displayName = 'LT-JDOE' } })
        }
        Mock Update-MgDevice -ModuleName Coretelligent.M365 -MockWith { }
    }

    It 'resolves the offboard target by display name when the case has no UPN' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-9'; UserPrincipalName = 'jpark@x.com'; AccountEnabled = $true } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Jordan Park' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Jordan Park'"
        $r.Upn | Should -Be 'jpark@x.com'
    }

    It 'stops (no action) when more than one user matches the display name' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { @([pscustomobject]@{ Id = 'a'; UserPrincipalName = 'a@x.com' }, [pscustomobject]@{ Id = 'b'; UserPrincipalName = 'b@x.com' }) }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Jordan Park' }) -Config ([pscustomobject]@{}) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Match 'match display name'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'revokes sign-in sessions by default on offboard' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        Should -Invoke Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'revoked sign-in sessions'
    }

    It 'does not revoke sessions when revokeSessions is false' {
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ revokeSessions = $false }) -MailboxSizeGB 10 | Out-Null
        Should -Invoke Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'removes only CLOUD groups; routes on-prem-synced/mail-enabled/dynamic instead of erroring' {
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ Id = 'g-cloud'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Cloud-Sec' } }
                [pscustomobject]@{ Id = 'g-onprem'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'DEPT-RemoteSupport'; onPremisesSyncEnabled = $true } }
                [pscustomobject]@{ Id = 'g-mail'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'TechStaff'; mailEnabled = $true } }
                [pscustomobject]@{ Id = 'g-dyn'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'All Users'; groupTypes = @('DynamicMembership') } }
            )
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeAllGroups = $true }) -MailboxSizeGB 10
        # Only the cloud security group is removed via Graph
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'g-cloud' } -Times 1 -Exactly
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 1 -Exactly  # and ONLY that one
        $a = $r.Actions -join ' '
        $a | Should -Match 'skipped on-prem-synced group: DEPT-RemoteSupport'
        $a | Should -Match 'skipped mail-enabled group/DL: TechStaff'
        $a | Should -Match 'skipped dynamic group: All Users'
    }

    It 'treats an "already not a member" / not-found group removal as done, not a warning (idempotent)' {
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @([pscustomobject]@{ Id = 'g-gone'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'M365 Power BI Pro' } })
        }
        Mock Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith {
            throw [Exception]::new("[Request_BadRequest] : One or more removed object references do not exist for the following modified properties: 'members'.")
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeAllGroups = $true }) -MailboxSizeGB 10
        $a = $r.Actions -join ' '
        $a | Should -Match 'already not a member of M365 Power BI Pro'
        $a | Should -Not -Match 'WARN could not remove from M365 Power BI Pro'
    }

    It 'disables Entra devices and captures their names when disableDevices is set' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ disableDevices = $true }) -MailboxSizeGB 10
        Should -Invoke Update-MgDevice -ModuleName Coretelligent.M365 -ParameterFilter { $DeviceId -eq 'dev-1' } -Times 1 -Exactly
        $r.Evidence.Devices.Count | Should -Be 1
        $r.Evidence.Devices[0].DisplayName | Should -Be 'LT-JDOE'
        ($r.Actions -join ' ') | Should -Match 'disabled Entra device: LT-JDOE'
    }

    It 'captures device evidence without disabling when only captureDevices is set' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ captureDevices = $true }) -MailboxSizeGB 10
        Should -Invoke Update-MgDevice -ModuleName Coretelligent.M365 -Times 0 -Exactly
        $r.Evidence.Devices.Count | Should -Be 1
    }

    It 'blocks sign-in, captures group evidence, and removes all groups' {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ blockSignIn = $true; removeAllGroups = $true; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 } }
        $r = Invoke-CtgM365Offboarding -User $user -Config $config -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        # evidence captured before removal
        $r.Evidence.Groups.Count | Should -Be 2
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1   # block sign-in
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 2 -Exactly
    }

    It 'keeps the license (no convert) when the mailbox is over the size threshold' {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50; aboveThreshold = 'skip-convert-and-keep-e3' } }
        $r = Invoke-CtgM365Offboarding -User $user -Config $config -MailboxSizeGB 75
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly   # license kept
        ($r.Actions -join ' ') | Should -Match 'over threshold'
    }

    It 'removes only DIRECTLY-assigned licenses and reports group-assigned ones' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true; LicenseAssignmentStates = @(
                [pscustomobject]@{ SkuId = 'sku-direct'; AssignedByGroup = $null },
                [pscustomobject]@{ SkuId = 'sku-e3'; AssignedByGroup = 'grp-lic' }
            ) }
        }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @(
            [pscustomobject]@{ SkuId = 'sku-direct'; SkuPartNumber = 'FLOW_FREE' },
            [pscustomobject]@{ SkuId = 'sku-e3'; SkuPartNumber = 'SPE_E3' }
        ) }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ DisplayName = 'M365 E3 Users Group' } }
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -ParameterFilter { ($RemoveLicenses -contains 'sku-direct') -and ($RemoveLicenses -notcontains 'sku-e3') } -Times 1
        ($r.Actions -join ' ') | Should -Match "license 'SPE_E3' is GROUP-ASSIGNED by 'M365 E3 Users Group'"
    }

    It 'removes the license when under the threshold and removeLicense is requested' {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 } }
        $r = Invoke-CtgM365Offboarding -User $user -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly   # license removed
    }
}

Describe 'Confirm-CtgM365' {
    BeforeEach {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:Skus }
    }

    It 'onboard: all checks pass when the user is enabled with the right license + group' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ SkuId = 'sku-e3' }) }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ AdditionalProperties = @{ displayName = 'Sales' } }) }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ licenses = @('Microsoft 365 E3'); groups = @('Sales') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'AccountEnabled' }).pass | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'license: Microsoft 365 E3' }).pass | Should -BeTrue
        # The check now names the group's type, e.g. "group: Sales (group)".
        ($r.checks | Where-Object { $_.name -like 'group: Sales*' }).pass | Should -BeTrue
    }

    It 'onboard: a missing group fails that check and overall ok' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('Sales') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        $r.ok | Should -BeFalse
        ($r.checks | Where-Object { $_.name -like 'group: Sales*' }).pass | Should -BeFalse
    }

    It 'onboard: mirror coverage counts only cloud groups (on-prem/dynamic the AD lane owns are excluded)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Resolve-CtgEntraUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'ref-1'; DisplayName = 'Davian Rodriguez' } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            param($UserId)
            if ($UserId -eq 'ref-1') {
                # reference user: one cloud group + one on-prem-synced + one dynamic
                @(
                    [pscustomobject]@{ Id = 'g-cloud';  AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Cloud-Sec'; onPremisesSyncEnabled = $false } }
                    [pscustomobject]@{ Id = 'g-onprem'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'RDS-Users'; onPremisesSyncEnabled = $true } }
                    [pscustomobject]@{ Id = 'g-dyn';    AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'All Users'; groupTypes = @('DynamicMembership') } }
                )
            } else {
                # new user: only in the cloud group (NOT the on-prem one — the AD lane hasn't synced it)
                @([pscustomobject]@{ Id = 'g-cloud'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Cloud-Sec'; onPremisesSyncEnabled = $false } })
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'ddirienzo@x.com' }
        $config = [pscustomobject]@{ licenses = @(); groups = @(); mirrorFromUser = 'Davian Rodriguez' }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        $mc = $r.checks | Where-Object { $_.name -like 'mirror coverage*' }
        $mc.pass | Should -BeTrue                                   # on-prem RDS-Users + dynamic All Users are NOT counted missing
        $mc.name | Should -Match 'all 1 of'                         # only the 1 cloud group is in scope
        $mc.name | Should -Not -Match 'RDS-Users'
    }

    It 'onboard: each group check NAMES its type (distribution list / security / 365 Group)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ AdditionalProperties = @{ displayName = 'All Staff DL';  mailEnabled = $true;  securityEnabled = $false; groupTypes = @() } }
                [pscustomobject]@{ AdditionalProperties = @{ displayName = 'VPN Users';     mailEnabled = $false; securityEnabled = $true;  groupTypes = @() } }
                [pscustomobject]@{ AdditionalProperties = @{ displayName = 'Project Alpha'; mailEnabled = $true;  securityEnabled = $false; groupTypes = @('Unified') } }
            )
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('All Staff DL', 'VPN Users', 'Project Alpha') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        $names = @($r.checks | ForEach-Object { $_.name })
        $names | Should -Contain 'group: All Staff DL (distribution list)'
        $names | Should -Contain 'group: VPN Users (security)'
        $names | Should -Contain 'group: Project Alpha (365 Group)'
    }

    It 'onboard: a config name validates against a differently-cased/spaced real name (TEAMDCG -> "Team DCG")' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        # The user IS a member; the group's real identity differs from the config string by space + case
        # (name "Team DCG", alias "TeamDCG", mail "TeamDCG@dcg.co"). Normalized matching must still pass.
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @([pscustomobject]@{ AdditionalProperties = @{ displayName = 'Team DCG'; mailNickname = 'TeamDCG'; mail = 'TeamDCG@dcg.co'; mailEnabled = $true; securityEnabled = $false; groupTypes = @('Unified') } })
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'lshkembi@dcg.co' }
        # all three spellings (config name, alias, full email) must resolve to the same membership
        $config = [pscustomobject]@{ licenses = @(); groups = @('TEAMDCG', 'TeamDCG@dcg.co') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        ($r.checks | Where-Object { $_.name -eq 'group: TEAMDCG (365 Group)' }).pass | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'group: TeamDCG@dcg.co (365 Group)' }).pass | Should -BeTrue
    }

    It 'onboard: a configured DYNAMIC group the user is not yet in passes as auto-managed (not a MISS)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }   # not in any group yet
        # the configured group resolves to a dynamic group — rule-computed, can't be added manually
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'g-dyn'; GroupTypes = @('DynamicMembership') } }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('All Users') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        ($r.checks | Where-Object { $_.name -eq 'group: All Users (dynamic — auto-managed)' }).pass | Should -BeTrue
    }

    It 'offboard: passes when sign-in is blocked and groups are gone' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $false } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ removeAllGroups = $true }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}

Describe 'Invoke-CtgEntraTap' {
    It 'issues a TAP and post-dates it to the start day at 8am when the start date is future' {
        Mock Resolve-CtgEntraUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; DisplayName = 'Drew' } }
        Mock Get-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock New-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $BodyParameter)
            [pscustomobject]@{ TemporaryAccessPass = 'AB12CD34'; StartDateTime = $BodyParameter.startDateTime; LifetimeInMinutes = $BodyParameter.lifetimeInMinutes }
        }
        $future = (Get-Date).AddDays(3).ToString('yyyy-MM-dd')
        $r = Invoke-CtgEntraTap -User ([pscustomobject]@{ UserPrincipalName = 'ddirienzo@x.com'; StartDate = $future }) -Config ([pscustomobject]@{ startHour = 8; lifetimeMinutes = 240 })
        $r.Status | Should -Be 'ok'
        $r.Tap | Should -Be 'AB12CD34'
        $r.TapLifetimeMinutes | Should -Be 240
        # startDateTime was set (future start), issued with a 240-min lifetime
        Should -Invoke New-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -ParameterFilter { $BodyParameter.lifetimeInMinutes -eq 240 -and $BodyParameter.startDateTime } -Times 1
        ($r.Actions -join ' ') | Should -Match 'AB12CD34'
    }

    It 'replaces an existing TAP before issuing a new one (one per user)' {
        Mock Resolve-CtgEntraUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; DisplayName = 'Drew' } }
        Mock Get-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = 'tap-old' }) }
        Mock Remove-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -MockWith {}
        Mock New-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ TemporaryAccessPass = 'NEW99'; LifetimeInMinutes = 240 } }
        $r = Invoke-CtgEntraTap -User ([pscustomobject]@{ UserPrincipalName = 'ddirienzo@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Remove-MgUserAuthenticationTemporaryAccessPassMethod -ModuleName Coretelligent.M365 -ParameterFilter { $TemporaryAccessPassAuthenticationMethodId -eq 'tap-old' } -Times 1
        $r.Tap | Should -Be 'NEW99'
        ($r.Actions -join ' ') | Should -Match 'replaced an existing TAP'
    }
}

Describe 'Invoke-CtgM365CloudMirror' {
    It 'mirrors cloud-only groups, skipping on-prem-synced and dynamic groups' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'ref-1'; UserPrincipalName = 'jsmith@x.com' } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'ref-1' } -MockWith {
            @(
                [pscustomobject]@{ Id = 'g-cloud';  AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'APP - M365 E3'; onPremisesSyncEnabled = $false } }
                [pscustomobject]@{ Id = 'g-onprem'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'RDS-Users'; onPremisesSyncEnabled = $true } }
                [pscustomobject]@{ Id = 'g-dyn';    AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Dyn'; onPremisesSyncEnabled = $false; groupTypes = @('DynamicMembership') } }
                [pscustomobject]@{ Id = 'g-role';   AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.directoryRole'; displayName = 'Helpdesk Admin' } }
            )
        }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'uid-1' } -MockWith { @() }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'g' } }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith {}

        $acts = Invoke-CtgM365CloudMirror -MirrorUser 'jsmith@x.com' -UserId 'uid-1'
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $GroupId -eq 'g-cloud' }
        ($acts -join ' ') | Should -Match 'mirrored cloud group: APP - M365 E3'
        ($acts -join ' ') | Should -Match '1 added, 2 skipped'
    }

    It 'warns when the mirror user is not found in Entra' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }
        $acts = Invoke-CtgM365CloudMirror -MirrorUser 'ghost@x.com' -UserId 'uid-1'
        ($acts -join ' ') | Should -Match 'mirror user not found'
    }

    It 'skips Exchange-managed (distribution/mail-enabled) and already-member groups; adds Unified + security' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'ref-1'; UserPrincipalName = 'jsmith@x.com' } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'ref-1' } -MockWith {
            @(
                [pscustomobject]@{ Id = 'g-dl';      AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Billing Team'; onPremisesSyncEnabled = $false; mailEnabled = $true; groupTypes = @() } }
                [pscustomobject]@{ Id = 'g-unified'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Calendar Billing'; onPremisesSyncEnabled = $false; mailEnabled = $true; groupTypes = @('Unified') } }
                [pscustomobject]@{ Id = 'g-have';    AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'US FTEs'; onPremisesSyncEnabled = $false } }
            )
        }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'uid-1' } -MockWith { @([pscustomobject]@{ Id = 'g-have' }) }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'g' } }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith {}

        $acts = Invoke-CtgM365CloudMirror -MirrorUser 'jsmith@x.com' -UserId 'uid-1'
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $GroupId -eq 'g-unified' }
        ($acts -join ' ') | Should -Match 'Billing Team.*added by the Exchange step'
        ($acts -join ' ') | Should -Match 'already in group: US FTEs'
        ($acts -join ' ') | Should -Match 'mirrored cloud group: Calendar Billing'
    }
}

Describe 'Set-CtgSeatAwareLicense' {
    BeforeEach {
        $script:cfg = [pscustomobject]@{ skuId='sku-e5'; entraGroupWhenAvailable='e5-group'; adGroupFallback='M365 E3 Users Group' }
        # The group-add pre-checks the group exists before adding — return a group for any id.
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'g' } }
    }

    It 'adds to the E5 Entra group when a seat is available' {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ PrepaidUnits=[pscustomobject]@{ Enabled=100 }; ConsumedUnits=40 } }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith {}
        $r = Set-CtgSeatAwareLicense -UserId 'u1' -Config $cfg
        $r.Tier | Should -Be 'E5'
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'e5-group' } -Times 1
    }

    It 'falls back to the E3 AD group when no E5 seat is free' {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ PrepaidUnits=[pscustomobject]@{ Enabled=100 }; ConsumedUnits=100 } }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith {}
        $r = Set-CtgSeatAwareLicense -UserId 'u1' -Config $cfg
        $r.Tier | Should -Be 'E3'
        $r.FallbackAdGroup | Should -Be 'M365 E3 Users Group'
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 0 -Exactly  # AD group not added via Graph
    }

    It 'adds to an E3 Entra group via Graph when one is configured' {
        $cfg2 = [pscustomobject]@{ skuId='sku-e5'; entraGroupWhenAvailable='e5-group'; entraGroupFallback='e3-group' }
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ PrepaidUnits=[pscustomobject]@{ Enabled=5 }; ConsumedUnits=5 } }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith {}
        $r = Set-CtgSeatAwareLicense -UserId 'u1' -Config $cfg2
        $r.Tier | Should -Be 'E3'
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'e3-group' } -Times 1
    }
}
