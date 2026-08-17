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
    function global:Get-MgUser { param($UserId, $Filter, [switch]$All, $ConsistencyLevel, $CountVariable, $Top, $Property) }
    function global:New-MgUser {}
    function global:Get-MgUserLicenseDetail {}
    function global:Set-MgUserLicense { param($UserId, $AddLicenses, $RemoveLicenses) }
    function global:Get-MgGroup { param($GroupId, $Filter, $Property, $Top, $ConsistencyLevel, $CountVariable, [switch]$All) }
    function global:Get-MgGroupMember {}
    function global:New-MgGroupMember { param($GroupId, $DirectoryObjectId) }
    function global:Update-MgUser { param($UserId, $Department, $OfficeLocation, $JobTitle, $MobilePhone, $CompanyName, $StreetAddress, $City, $State, $PostalCode, $Country, $BusinessPhones, $OnPremisesExtensionAttributes, $AccountEnabled, $ProxyAddresses, $UsageLocation, $PasswordProfile) }
    function global:Set-MgUserManagerByRef { param($UserId, $BodyParameter) }
    function global:Get-MgUserManager { param($UserId) }
    function global:Remove-MgUserManagerByRef { param($UserId) }
    function global:Get-MgUserMemberOf { param($UserId, [switch]$All) }
    function global:Remove-MgGroupMemberByRef { param($GroupId, $DirectoryObjectId) }
    function global:Get-MgUserDefaultDrive {}
    function global:Invoke-MgGraphRequest { param($Method, $Uri, $Body, $ErrorAction) }
    function global:Revoke-MgUserSignInSession { param($UserId) }
    function global:Get-MgUserRegisteredDevice { param($UserId, [switch]$All) }
    function global:Update-MgDevice { param($DeviceId, $AccountEnabled) }
    function global:Get-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId) }
    function global:New-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId, $BodyParameter) }
    function global:Remove-MgUserAuthenticationTemporaryAccessPassMethod { param($UserId, $TemporaryAccessPassAuthenticationMethodId) }
    # Offboard: strip the leaver's registered second factors.
    function global:Get-MgUserAuthenticationMethod { param($UserId) }
    function global:Remove-MgUserAuthenticationPhoneMethod { param($UserId, $PhoneAuthenticationMethodId) }
    function global:Remove-MgUserAuthenticationMicrosoftAuthenticatorMethod { param($UserId, $MicrosoftAuthenticatorAuthenticationMethodId) }
    function global:Remove-MgUserAuthenticationFido2Method { param($UserId, $Fido2AuthenticationMethodId) }
    function global:Remove-MgUserAuthenticationSoftwareOathMethod { param($UserId, $SoftwareOathAuthenticationMethodId) }
    function global:Remove-MgUserAuthenticationWindowsHelloForBusinessMethod { param($UserId, $WindowsHelloForBusinessAuthenticationMethodId) }
    function global:Remove-MgUserAuthenticationEmailMethod { param($UserId, $EmailAuthenticationMethodId) }

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
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }       # profile attrs + usageLocation
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ SkuId = 'sku-e3' }) } # E3 already present
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'grp-1' } }
        Mock Get-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { }
    }

    Context 'ad-synced adopt-only (cloudCreate=deny)' {
        # NB: Pester v5 runs the Context body in DISCOVERY and It blocks in RUN, so $user/$pwd must be
        # built INSIDE each It (a Context-scope var is $null at run time) — matching the tests above.
        It 'does NOT create and fails clearly when no account exists anywhere' {
            $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
            $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }   # UPN candidates AND broader search miss
            { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'deny' }) -InitialPassword $pwd } |
                Should -Throw -ExpectedMessage '*no synced M365 account*did NOT create*'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        }

        It 'raises DECISION_NEEDED:synced_upn_mismatch when a synced user exists under a DIFFERENT UPN' {
            $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
            $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
                param($UserId, $Filter)
                # UPN-candidate lookups (by -UserId) miss; the broader displayName+onPremisesSyncEnabled filter hits.
                if ("$Filter" -match "displayName eq 'Jane Doe'") {
                    return [pscustomobject]@{ Id='uid-synced'; DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; OnPremisesSyncEnabled=$true }
                }
                return $null
            }
            { Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'deny' }) -InitialPassword $pwd } |
                Should -Throw -ExpectedMessage '*DECISION_NEEDED:synced_upn_mismatch*expected=jane.doe@x.com*found=jdoe@x.com*'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        }

        It 'STILL creates when cloudCreate=allow and no account exists (override / non-ad-synced)' {
            $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; UserPrincipalNameFallbacks=@(); FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
            $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }
            $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ cloudCreate = 'allow' }) -InitialPassword $pwd
            $r.Status | Should -Be 'ok'
            Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
        }
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

    It 'ENABLES an adopted account that is disabled (a rehire whose old account was disabled)' {
        # The bug this pins: adopting stamped the marker and moved on, but only the CREATE path ever
        # set AccountEnabled. A rehire's old account is disabled, so the onboard reported success while
        # leaving a user who could not sign in (validation flagged "AccountEnabled" and nothing acted).
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') {
                return [pscustomobject]@{ Id = 'uid-jane'; DisplayName = 'Jane Doe'; AccountEnabled = $false; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = $null } }
            }
            return $null
        }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith {}
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ usernameCollisionPolicy = 'adopt' }) -InitialPassword $pwd
        Should -Invoke New-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $AccountEnabled -eq $true } -Times 1
        ($r.Actions -join ' ') | Should -Match 'enabled jdoe@x.com'
    }

    It 'does NOT re-enable an adopted account that is already enabled (idempotent)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($UserId -eq 'jdoe@x.com' -or "$Filter" -match 'jdoe@x\.com') {
                return [pscustomobject]@{ Id = 'uid-jane'; DisplayName = 'Jane Doe'; AccountEnabled = $true; OnPremisesExtensionAttributes = [pscustomobject]@{ ExtensionAttribute1 = $null } }
            }
            return $null
        }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith {}
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; UserPrincipalNameFallbacks=@('j.doe@x.com'); PersonalEmail='jane@gmail.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config ([pscustomobject]@{ usernameCollisionPolicy = 'adopt' }) -InitialPassword $pwd
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $AccountEnabled -eq $true } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Not -Match 'enabled jdoe@x.com'
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
        # usageLocation must be set before licensing (else Graph: "invalid usage location") — regression
        # for UM0029655, where a synced user had no usageLocation and the E3 assignment was rejected.
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UsageLocation -eq 'US' } -Times 1
    }

    It 'defaults usageLocation to US before licensing when the intake omits it (synced user)' {
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone='' }  # no UsageLocation
        $config = [pscustomobject]@{ licenses = @('Microsoft Entra ID P2') }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UsageLocation -eq 'US' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'set usageLocation: US'
    }

    It 'assigns MULTIPLE missing licenses in ONE call (interdependent service plans)' {
        # UM0029655: Defender for O365 P2's plan depends on Exchange Online (in E3); assigned one-by-one
        # Graph rejects it ("service plan ... depends on ..."). Batch all new licenses into a single
        # Set-MgUserLicense so co-dependent plans enable together.
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }  # none assigned yet
        $user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $config = [pscustomobject]@{ licenses = @('Microsoft 365 E3', 'Microsoft Entra ID P2') }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        $r.Status | Should -Be 'ok'
        # ONE call carrying BOTH SkuIds — not two separate per-license calls.
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { @($AddLicenses).Count -eq 2 }
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
        # A typical leaver: a password (NOT removable via Graph) plus two live second factors.
        Mock Get-MgUserAuthenticationMethod -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ Id = 'pw-1';   AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.passwordAuthenticationMethod' } }
                [pscustomobject]@{ Id = 'ph-1';   AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.phoneAuthenticationMethod' } }
                [pscustomobject]@{ Id = 'auth-1'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' } }
            )
        }
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith { }
        Mock Remove-MgUserAuthenticationMicrosoftAuthenticatorMethod -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserManager -ModuleName Coretelligent.M365 -MockWith { $null }   # no manager set by default
        Mock Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -MockWith { }
    }

    It 'resolves the offboard target by display name when the case has no UPN' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-9'; UserPrincipalName = 'jpark@x.com'; AccountEnabled = $true } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Jordan Park' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Jordan Park'"
        $r.Upn | Should -Be 'jpark@x.com'
    }

    # The REAL shape of a ServiceNow UM offboard payload: the leaver is carried as `userToOffboard`
    # (a display name) and there is NO UserPrincipalName/DisplayName property at all. Under
    # StrictMode a bare $User.UserPrincipalName on that object THROWS ("The property
    # 'UserPrincipalName' cannot be found on this object") — the UM0029766 failure.
    It 'resolves a UM-shaped payload that carries only userToOffboard' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-7'; UserPrincipalName = 'pshah@x.com'; AccountEnabled = $true } }
        $um = [pscustomobject]@{ userToOffboard = 'Parth Shah'; dateOfOffboarding = '2026-07-14'; collectComputer = $true }
        $r = Invoke-CtgM365Offboarding -User $um -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Upn | Should -Be 'pshah@x.com'
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Parth Shah'"
    }

    # The email ServiceNow resolves from the contact record is a CLAIM, not a fact: it can be an alias
    # (p.shah@x.com) rather than the Entra UPN (pshah@x.com). The executor falls through to the
    # display-name search when it doesn't resolve — and Resolve-CtgM365Upn (what the VALIDATOR uses)
    # must reach the same user, or the validator "misses" the person the executor just offboarded.
    It 'validator resolver falls back to the name when the case email is not a real UPN' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-7'; UserPrincipalName = 'pshah@x.com' } }
        $um = [pscustomobject]@{ userToOffboard = 'Parth Shah'; email = 'p.shah@x.com' }
        InModuleScope Coretelligent.M365 -Parameters @{ U = $um } { param($U) Resolve-CtgM365Upn -User $U } | Should -Be 'pshah@x.com'
    }

    # When the intake resolved the leaver's contact email, match on it — an email is stable across
    # ServiceNow and 365, a display name is not ("James (Jim) Goodmiller" vs "Jim Goodmiller").
    It 'prefers the payload email over the display name' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-8'; UserPrincipalName = 'pshah@x.com'; AccountEnabled = $true } }
        $um = [pscustomobject]@{ userToOffboard = 'Parth Shah'; email = 'pshah@x.com' }
        $r = Invoke-CtgM365Offboarding -User $um -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Upn | Should -Be 'pshah@x.com'
        Should -Invoke Get-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Filter -match 'displayName eq' }
    }

    # A contact reference whose display value IS the email (SNOW does this) must be treated as a UPN,
    # not searched for as a display name.
    It 'treats an email-shaped userToOffboard as the UPN' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { [pscustomobject]@{ Id = 'uid-8'; UserPrincipalName = 'pshah@x.com'; AccountEnabled = $true } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ userToOffboard = 'pshah@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Upn | Should -Be 'pshah@x.com'
        Should -Invoke Get-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Filter -match 'displayName eq' }
    }

    # A case with NOTHING to identify the leaver used to come back green ("user not found — nothing to
    # offboard") while the account stayed live. There is no worse outcome for an offboard than that.
    It 'fails loudly when the case carries no identifier at all' {
        { Invoke-CtgM365Offboarding -User ([pscustomobject]@{ collectComputer = $true }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10 } |
            Should -Throw -ExpectedMessage '*no UPN, email or name*'
    }

    # "Parth Shah" on the ticket, "Parth K. Shah" in the directory: the exact search finds nobody, so
    # searching exactly again can never help. Broaden, and hand the humans a shortlist to pick from —
    # rather than reporting "user not found — nothing to offboard" while the account stays live.
    It 'offers candidates (does not no-op) when the name matches nobody exactly' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith { @() }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'startswith' } -MockWith {
            @([pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'pshah@x.com'; DisplayName = 'Parth K. Shah'; JobTitle = 'Analyst'; Department = 'Sales'; AccountEnabled = $true; Mail = 'pshah@x.com' })
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ userToOffboard = 'Parth Shah' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Candidates.Count | Should -BeGreaterThan 0
        $r.Candidates[0].upn | Should -Be 'pshah@x.com'
        $r.CandidateReason | Should -Be 'no-match'
        $r.CandidateQuery | Should -Be 'Parth Shah'
        # NOTHING may be touched while we don't know who the person is.
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'returns the matching users as candidates when the display name is ambiguous' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'userPrincipalName eq' } -MockWith { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'displayName eq' } -MockWith {
            @(
                [pscustomobject]@{ Id = 'a'; UserPrincipalName = 'a@x.com'; DisplayName = 'Parth Shah'; AccountEnabled = $true }
                [pscustomobject]@{ Id = 'b'; UserPrincipalName = 'b@x.com'; DisplayName = 'Parth Shah'; AccountEnabled = $false }
            )
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ userToOffboard = 'Parth Shah' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.CandidateReason | Should -Be 'ambiguous'
        $r.Candidates.Count | Should -Be 2
        @($r.Candidates.upn) | Should -Contain 'b@x.com'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
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

    # FR #12 (UM0029777): a cloud-mastered leaver kept their manager forever — only the AD lane
    # cleared the link, and a cloud-only client has no AD lane.
    It 'clears the manager on a cloud-mastered user and captures who it was' {
        Mock Get-MgUserManager -ModuleName Coretelligent.M365 -MockWith {
            [pscustomobject]@{ Id = 'mgr-1'; AdditionalProperties = @{ displayName = 'Dana Boss'; mail = 'dboss@x.com' } }
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        Should -Invoke Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'cleared manager: Dana Boss'
        $r.Manager.Email | Should -Be 'dboss@x.com'
    }

    It 'routes the manager clear to the AD step for an AD-synced user (Graph would refuse the write)' {
        Mock Get-MgUserManager -ModuleName Coretelligent.M365 -MockWith {
            [pscustomobject]@{ Id = 'mgr-1'; AdditionalProperties = @{ displayName = 'Dana Boss'; mail = 'dboss@x.com' } }
        }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Property -eq 'OnPremisesSyncEnabled' } -MockWith {
            [pscustomobject]@{ Id = 'uid-1'; OnPremisesSyncEnabled = $true }
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        Should -Invoke Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'on-prem-mastered'
        # Still captured as evidence — the app hands it to Exchange's manager-delegate fallback.
        $r.Manager.Name | Should -Be 'Dana Boss'
    }

    It 'reports "no manager set" (and no write) when the user has no manager' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        Should -Invoke Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no manager set'
        $r.Manager | Should -BeNullOrEmpty
    }

    # FR #8: the case-named delegate gets access to the leaver's whole OneDrive (planner injects
    # config.oneDriveGrantAccessTo from the intake's provideMailboxAccessTo).
    It 'grants the case-requested delegate access to the OneDrive' {
        Mock Resolve-CtgEntraUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'd1'; Mail = 'phegland@x.com'; UserPrincipalName = 'phegland@x.com' } }
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-1'; webUrl = 'https://contoso-my.sharepoint.com/personal/jdoe' } }
            if ($Uri -match '/permissions$') { return @{ value = @() } }
            if ($Uri -match '/invite$') { return @{ value = @() } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveGrantAccessTo = 'phegland@x.com' }) -MailboxSizeGB 10
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Uri -match '/invite$' }
        ($r.Actions -join ' ') | Should -Match 'granted delegate phegland@x.com access'
    }

    It 'reports "no OneDrive provisioned" instead of failing when the leaver has no drive' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith { throw 'itemNotFound: mysite not found' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveGrantAccessTo = 'phegland@x.com' }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no OneDrive provisioned'
    }

    # FR #9: archive the OneDrive into the configured target. Graph /copy is ASYNC, so done-ness is
    # verified by LISTING the destination: items already there are skipped, anything just initiated
    # schedules an auto-re-run (RetryAfterMinutes) that later confirms completion.
    It 'archives the OneDrive to the target: skips items already in the archive, re-runs to confirm the rest' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/users/archives@x.com/drive') { return @{ id = 'drv-dst'; webUrl = 'https://od/arch' } }
            if ($Uri -match '/root:/Archive') { throw 'itemNotFound' }
            if ($Method -eq 'POST' -and $Uri -match '/drives/drv-dst/root/children') { return @{ id = 'fold-1' } }
            if ($Uri -match '/drives/drv-dst/items/fold-1/children') { return @{ value = @(@{ name = 'Budget.xlsx' }) } }   # already archived
            if ($Uri -match '/drives/drv-src/root/children') { return @{ value = @(@{ id = 'i1'; name = 'Documents' }, @{ id = 'i2'; name = 'Budget.xlsx' }) } }
            if ($Uri -match '/copy$') { return $null }   # 202, async
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'archives@x.com' } }) -MailboxSizeGB 10
        # only the item MISSING from the destination is copied; the present one is never re-copied
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $Uri -match '/items/i1/copy$' }
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/items/i2/copy$' }
        ($r.Actions -join ' ') | Should -Match '1 copy initiated'
        ($r.Actions -join ' ') | Should -Match '1 already archived'
        $r.RetryAfterMinutes | Should -Be 10   # in flight -> the app re-runs to confirm
    }

    It 'reports the archive COMPLETE (and schedules no re-run) once every item is in the destination' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/users/archives@x.com/drive') { return @{ id = 'drv-dst'; webUrl = 'https://od/arch' } }
            if ($Uri -match '/root:/Archive') { return @{ id = 'fold-1' } }
            if ($Uri -match '/drives/drv-dst/items/fold-1/children') { return @{ value = @(@{ name = 'Documents' }, @{ name = 'Budget.xlsx' }) } }
            if ($Uri -match '/drives/drv-src/root/children') { return @{ value = @(@{ id = 'i1'; name = 'Documents' }, @{ id = 'i2'; name = 'Budget.xlsx' }) } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'archives@x.com' } }) -MailboxSizeGB 10
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/copy$' }
        ($r.Actions -join ' ') | Should -Match 'OneDrive archive complete: all 2 item'
        $r.RetryAfterMinutes | Should -BeNullOrEmpty
    }

    It 'warns (fail-soft) when the OneDrive archive target is missing or unusable' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{} }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN oneDriveBackup is set but has no target'
        # FR#38: a bare string is treated as a SharePoint site NAME; 'not-a-target' matches no site
        # (the default mock answers the search with nothing), so this is now a zero-hit search WARN.
        $bad = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'not-a-target' } }) -MailboxSizeGB 10
        ($bad.Actions -join ' ') | Should -Match "WARN OneDrive archive to 'not-a-target' did not run"
        ($bad.Actions -join ' ') | Should -Match "no SharePoint site found matching 'not-a-target'"
    }

    # FR#38: the archive target may be a SharePoint site DISPLAY NAME — Six One's profile stores the
    # prose "Offboarded User Data SharePoint site", which used to throw "unrecognized OneDrive archive
    # target" (only URLs and emails were accepted). The prose suffix is stripped and the name resolved
    # via Graph site search; anything short of an unambiguous match refuses — never guess a
    # destination for data archival.
    It 'resolves a bare SharePoint site NAME as the archive target and archives into it' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=Offboarded%20User%20Data') { return @{ value = @(@{ id = 'site-1'; displayName = 'Offboarded User Data' }) } }
            if ($Uri -match '/sites/site-1/drive') { return @{ id = 'drv-dst'; webUrl = 'https://sp/offboarded' } }
            if ($Uri -match '/root:/Archive') { throw 'itemNotFound' }
            if ($Method -eq 'POST' -and $Uri -match '/drives/drv-dst/root/children') { return @{ id = 'fold-1' } }
            if ($Uri -match '/drives/drv-dst/items/fold-1/children') { return @{ value = @() } }
            if ($Uri -match '/drives/drv-src/root/children') { return @{ value = @(@{ id = 'i1'; name = 'Documents' }) } }
            if ($Uri -match '/copy$') { return $null }   # 202, async
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Offboarded User Data SharePoint site' } }) -MailboxSizeGB 10
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $Uri -match '/copy$' }
        ($r.Actions -join ' ') | Should -Match 'OneDrive archive ->'
        ($r.Actions -join ' ') | Should -Match "SharePoint site 'Offboarded User Data'"
    }

    # REGRESSION (PR review): the prose suffix must not shadow a site literally NAMED with it.
    # A tenant holding both "HR" and "HR Site" with target "HR Site" used to strip to "HR",
    # exact-match "HR", and silently archive the leaver's data into the WRONG site. The ORIGINAL
    # target name wins over the stripped form when both match exactly.
    It 'prefers a site named EXACTLY like the original target over the suffix-stripped form' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=HR') { return @{ value = @(@{ id = 's-hr'; displayName = 'HR' }, @{ id = 's-hrsite'; displayName = 'HR Site' }) } }
            if ($Uri -match '/sites/s-hrsite/drive') { return @{ id = 'drv-dst'; webUrl = 'https://sp/hrsite' } }
            if ($Uri -match '/sites/s-hr/drive') { return @{ id = 'drv-WRONG'; webUrl = 'https://sp/hr' } }
            if ($Uri -match '/root:/Archive') { throw 'itemNotFound' }
            if ($Method -eq 'POST' -and $Uri -match '/drives/drv-dst/root/children') { return @{ id = 'fold-1' } }
            if ($Uri -match '/drives/drv-dst/items/fold-1/children') { return @{ value = @() } }
            if ($Uri -match '/drives/drv-src/root/children') { return @{ value = @(@{ id = 'i1'; name = 'Documents' }) } }
            if ($Uri -match '/copy$') { return $null }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'HR Site' } }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Match "SharePoint site 'HR Site'"
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/drives/drv-WRONG' }
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $Uri -match '/copy$' }
    }

    # Graph's site search is FUZZY (it also matches description/webUrl) — a lone irrelevant hit
    # must not become the archive destination just because it was the only one.
    It 'refuses a single search hit whose name does not contain the configured name' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=') { return @{ value = @(@{ id = 's-x'; displayName = 'Marketing' }) } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Offboarded User Data' } }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/copy$' }
        ($r.Actions -join ' ') | Should -Match "WARN OneDrive archive to 'Offboarded User Data' did not run"
        ($r.Actions -join ' ') | Should -Match "'Marketing'"
    }

    It 'refuses (fail-soft) when the site name matches MORE THAN ONE site — never guesses' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=') { return @{ value = @(@{ id = 's1'; displayName = 'Archive One' }, @{ id = 's2'; displayName = 'Archive Two' }) } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Archive' } }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/copy$' }
        ($r.Actions -join ' ') | Should -Match "WARN OneDrive archive to 'Archive' did not run"
        ($r.Actions -join ' ') | Should -Match '2 SharePoint sites match'
        # The search plainly WORKED here — pointing at the Sites.Read.All grant would be the same
        # misleading-hint pattern this FR fixed. That NB belongs to the zero-hit message only.
        ($r.Actions -join ' ') | Should -Not -Match 'Sites\.Read\.All'
    }

    It 'refuses (fail-soft) when NO site matches the configured name, and names Sites.Read.All' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=') { return @{ value = @() } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Ghost Site' } }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $Uri -match '/copy$' }
        ($r.Actions -join ' ') | Should -Match "WARN OneDrive archive to 'Ghost Site' did not run"
        ($r.Actions -join ' ') | Should -Match 'no SharePoint site found matching'
        ($r.Actions -join ' ') | Should -Match 'Sites\.Read\.All'
    }

    # The archive catch used to append "(needs the Files.ReadWrite.All app role?)" to EVERY failure,
    # sending operators off to grant a permission that was never the problem (FR#38: the real error
    # was a config prose name). The hint now appears only on a real Graph 403.
    It 'does NOT blame the Files.ReadWrite.All app role for a config/resolution error' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=') { return @{ value = @() } }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Ghost Site' } }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Not -Match 'Files\.ReadWrite\.All'
    }

    It 'DOES name the Files.ReadWrite.All app role when Graph answers a real 403 during resolution' {
        Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
            if ($Uri -match '/users/uid-1/drive') { return @{ id = 'drv-src'; webUrl = 'https://od/jdoe' } }
            if ($Uri -match '/sites\?search=') { throw '{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}}' }
            return @{}
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; oneDriveBackup = [pscustomobject]@{ target = 'Offboarded User Data' } }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match "WARN OneDrive archive to 'Offboarded User Data' did not run"
        ($r.Actions -join ' ') | Should -Match 'Files\.ReadWrite\.All'
    }

    It 'honors removeManager: false (does not even read the manager)' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; removeManager = $false }) -MailboxSizeGB 10
        Should -Invoke Get-MgUserManager -ModuleName Coretelligent.M365 -Times 0 -Exactly
        Should -Invoke Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'does not revoke sessions when revokeSessions is false' {
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ revokeSessions = $false }) -MailboxSizeGB 10 | Out-Null
        Should -Invoke Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    # Revoking sessions kills the account TODAY; the registered second factors would otherwise come
    # back with it the moment someone re-enables the user (a rehire), and stay usable for SSPR.
    It 'removes the registered MFA methods by default on offboard' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        Should -Invoke Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -Times 1 -Exactly
        Should -Invoke Remove-MgUserAuthenticationMicrosoftAuthenticatorMethod -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'removed 2 registered MFA method'
        $r.Evidence.MfaMethods | Should -Contain 'phone'
        $r.Evidence.MfaMethods | Should -Contain 'microsoftAuthenticator'
    }

    # The password method cannot be deleted through Graph — attempting it would error every offboard.
    It 'never attempts to remove the password method' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Evidence.MfaMethods | Should -Not -Contain 'password'
        ($r.Actions -join ' ') | Should -Not -Match 'no removal path'
    }

    It 'does not touch MFA methods when removeMfaMethods is false' {
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeMfaMethods = $false }) -MailboxSizeGB 10 | Out-Null
        Should -Invoke Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    # REGRESSION: `continue` inside a switch branch only exits the SWITCH (a switch is itself a loop
    # in PowerShell), so an unknown method type used to fall through and get recorded as removed —
    # a false "we stripped this second factor" on the case evidence and the ServiceNow note.
    It 'never claims to have removed an auth method it has no removal path for' {
        Mock Get-MgUserAuthenticationMethod -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ Id = 'ph-1';  AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.phoneAuthenticationMethod' } }
                # Graph keeps adding types (Mac Platform SSO, hardware OATH, QR-code PIN…)
                [pscustomobject]@{ Id = 'plat-1'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.platformCredentialAuthenticationMethod' } }
            )
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Evidence.MfaMethods | Should -Not -Contain 'platformCredential'
        $r.Evidence.MfaMethods | Should -Contain 'phone'
        ($r.Actions -join ' ') | Should -Match "removed 1 registered MFA method"
        ($r.Actions -join ' ') | Should -Match "'platformCredential' has no removal path — STILL REGISTERED"
        ($r.Actions -join ' ') | Should -Match '1 MFA method\(s\) are STILL REGISTERED'
    }

    # A failed removal must never be summarized as "nothing to remove" — that reads as "clean".
    It 'reports methods left behind when every removal fails, instead of "no removable methods"' {
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith { throw 'Authorization_RequestDenied' }
        Mock Remove-MgUserAuthenticationMicrosoftAuthenticatorMethod -ModuleName Coretelligent.M365 -MockWith { throw 'Authorization_RequestDenied' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Not -Match 'no removable MFA methods were registered'
        ($r.Actions -join ' ') | Should -Match '2 MFA method\(s\) are STILL REGISTERED'
        $r.Evidence.MfaMethods | Should -BeNullOrEmpty
    }

    # Entra refuses to delete the user's DEFAULT second factor while other methods are registered, and
    # Graph enumerates phone EARLY — so the default was attempted first, refused, and left behind while
    # everything else came off (UM0029840, Easterseals). Retrying it once the others are gone is the fix.
    It 'retries the DEFAULT method after the others are gone, and removes it' {
        $script:phoneTries = 0
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith {
            $script:phoneTries++
            # Entra's real message, and its real behaviour: refused while the authenticator still
            # exists, allowed once it is the last method standing.
            if ($script:phoneTries -eq 1) {
                throw "[badRequest] : The requested authentication method id of [3179e48a-750b-4051-897c-87b9720928f7] matches the user's current default authentication method, and cannot be deleted until the default authentication method is changed"
            }
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10

        $script:phoneTries | Should -Be 2 -Because 'the default must be attempted again after the other methods are removed'
        ($r.Actions -join ' ') | Should -Match "removed 2 registered MFA method\(s\).*phone"
        ($r.Actions -join ' ') | Should -Not -Match 'STILL REGISTERED'
        $r.Evidence.MfaMethods | Should -Contain 'phone'
    }

    It 'orders the retry AFTER the other removals, not merely twice' {
        # Retrying immediately would hit the same refusal — the whole point is that the other methods
        # are gone by then. Pin the sequence, not just the count.
        $script:seq = [System.Collections.Generic.List[string]]::new()
        $script:phoneTries2 = 0
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith {
            $script:phoneTries2++
            $script:seq.Add("phone-try$($script:phoneTries2)")
            if ($script:phoneTries2 -eq 1) { throw "matches the user's current default authentication method, and cannot be deleted until the default authentication method is changed" }
        }
        Mock Remove-MgUserAuthenticationMicrosoftAuthenticatorMethod -ModuleName Coretelligent.M365 -MockWith { $script:seq.Add('authenticator') }
        $null = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($script:seq -join ',') | Should -Be 'phone-try1,authenticator,phone-try2'
    }

    It 'reports the default method as STILL REGISTERED when Entra refuses it even on the retry' {
        # The catch-22 Entra can get into (e.g. an alternate mobile set as default). Must not be
        # silently swallowed just because we retried — and must name the ORIGINAL reason.
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith {
            throw "matches the user's current default authentication method, and cannot be deleted until the default authentication method is changed"
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($r.Actions -join ' ') | Should -Match "'phone' auth method \(STILL REGISTERED — it is the account's DEFAULT second factor"
        ($r.Actions -join ' ') | Should -Match '1 MFA method\(s\) are STILL REGISTERED'
        ($r.Actions -join ' ') | Should -Match 'removed 1 registered MFA method\(s\): microsoftAuthenticator'
    }

    It 'does NOT retry a failure that is not the default-method block' {
        # A 403 or a transient must be reported once, not quietly attempted twice.
        $script:denied = 0
        Mock Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -MockWith { $script:denied++; throw 'Authorization_RequestDenied' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $script:denied | Should -Be 1
        ($r.Actions -join ' ') | Should -Match "could not remove the 'phone' auth method \(STILL REGISTERED\): Authorization_RequestDenied"
    }

    # UserAuthenticationMethod.ReadWrite.All is a MANUAL per-tenant grant most tenants won't have.
    # A 403 must not fail the offboard — but it must say loudly that the factors are still live.
    It 'warns (and does not fail) when the tenant has not granted the MFA-method permission' {
        Mock Get-MgUserAuthenticationMethod -ModuleName Coretelligent.M365 -MockWith { throw 'Authorization_RequestDenied: Insufficient privileges to complete the operation.' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'UserAuthenticationMethod.ReadWrite.All'
        ($r.Actions -join ' ') | Should -Match 'STILL REGISTERED'
        Should -Invoke Remove-MgUserAuthenticationPhoneMethod -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'removes only CLOUD groups; routes on-prem-synced/mail-enabled/dynamic instead of erroring' {
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith {
            @(
                [pscustomobject]@{ Id = 'g-cloud'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Cloud-Sec' } }
                [pscustomobject]@{ Id = 'g-onprem'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'DEPT-RemoteSupport'; onPremisesSyncEnabled = $true } }
                [pscustomobject]@{ Id = 'g-mail'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'TechStaff'; mailEnabled = $true } }
                [pscustomobject]@{ Id = 'g-dyn'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'All Users'; groupTypes = @('DynamicMembership') } }
                # FR#37: a Unified (M365) group is mail-enabled but Graph-REMOVABLE — the Exchange DL
                # sweep (Get-DistributionGroup) never sees it, so skipping it here left it forever.
                [pscustomobject]@{ Id = 'g-unified'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = '61C LNG'; mailEnabled = $true; groupTypes = @('Unified') } }
                # ...unless it is ALSO dynamic — membership is rule-managed, Graph refuses the write.
                [pscustomobject]@{ Id = 'g-uni-dyn'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'All Staff Hub'; mailEnabled = $true; groupTypes = @('Unified', 'DynamicMembership') } }
            )
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeAllGroups = $true }) -MailboxSizeGB 10
        # The cloud security group AND the Unified group are removed via Graph
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'g-cloud' } -Times 1 -Exactly
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'g-unified' } -Times 1 -Exactly
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 2 -Exactly  # and ONLY those two
        $a = $r.Actions -join ' '
        $a | Should -Match 'skipped on-prem-synced group: DEPT-RemoteSupport'
        $a | Should -Match 'skipped mail-enabled group/DL: TechStaff'
        $a | Should -Match 'skipped dynamic group: All Users'
        $a | Should -Match 'removed from group: 61C LNG'
        $a | Should -Not -Match 'skipped mail-enabled group/DL: 61C LNG'
        # Unified + dynamic still skips as dynamic (rule-managed)
        $a | Should -Match 'skipped dynamic group: All Staff Hub'
        # Evidence snapshot carries the Unified flag so a run report can show the routing
        ($r.Evidence.Groups | Where-Object Id -eq 'g-unified').Unified | Should -BeTrue
        ($r.Evidence.Groups | Where-Object Id -eq 'g-mail').Unified | Should -BeFalse
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
        # Unchanged behaviour, new wording: the licence still stays, and the run now ASKS instead of
        # leaving a warning nobody owns. (The wording moved from "over threshold" to "over the N GB cap".)
        ($r.Actions -join ' ') | Should -Match 'over the 50 GB cap'
        ($r.Actions -join ' ') | Should -Match 'DECISION_NEEDED:mailbox_oversize'
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

    # --- convert-to-shared BEFORE the license comes off --------------------------------------------
    # Taking the license off a mailbox that was never converted to shared is destructive: Exchange
    # purges an unlicensed, unconverted mailbox once its 30-day grace runs out. The Exchange step tells
    # us whether it actually converted (config.mailboxConverted, injected by the app at claim time).
    It 'KEEPS the license when the mailbox was not converted to shared' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'WARN license KEPT .* NOT converted to shared'   # WARN = it surfaces to a human
    }

    # The fleet-wide safety net: most profiles remove the licence in a step that runs BEFORE Exchange
    # converts. Rather than trust 134 clients' orderings, refuse while a configured conversion is still
    # pending — a mis-ordered profile becomes SAFE (licence kept + warning) instead of destructive.
    It 'KEEPS the license while a configured mailbox conversion has not run yet' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailboxConvertPending = $true }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match "WARN license KEPT .* hasn't run yet"
    }

    It 'removes the license once the mailbox IS shared' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailboxConverted = $true }
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10 | Out-Null
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
    }

    # --- over the cap: ASK, don't pick -------------------------------------------------------------
    # Past the cap the mailbox CANNOT become shared (a mailbox that big needs a licence either way), so
    # the two goals genuinely conflict: the seat costs money, the mail is unrecoverable. No default is
    # right — it is the client's call.
    It 'ASKS when the mailbox is over the cap, and keeps the license meanwhile' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 60
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'DECISION_NEEDED:mailbox_oversize \|.*sizeGB=60 \| thresholdGB=50'
        ($r.Actions -join ' ') | Should -Match 'WARN license KEPT for now'
    }

    It 'removes the license when the operator answered "remove" on the oversize decision' {
        # The trap: after the answer, the size branch no longer matches — so the NEXT guard
        # ("was NOT converted") would catch it and keep the licence anyway, silently ignoring the
        # answer. Every convert guard has to honour the same decision.
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }
                                     mailboxConverted = $false; mailboxOversizePolicy = 'remove' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 60
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'license removed by operator decision .* over the 50 GB cap'
        ($r.Actions -join ' ') | Should -Match 'Exchange will DELETE it'
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED'   # answered — never ask twice
        # A WARN here parked the case at the "warning" verdict permanently, with nothing left for
        # anyone to do — run-report promotes a succeeded step to "warning" on any /\bWARN\b/ line.
        # A WARN means "a human still has to answer something"; this one has been answered.
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'
    }

    It 'keeps the license, and stops asking, when the operator answered "keep"' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }
                                     mailboxConverted = $false; mailboxOversizePolicy = 'keep' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 60
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'license KEPT by operator decision'
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED'
        ($r.Actions -join ' ') | Should -Not -Match 'WARN license KEPT for now'  # decided is not unresolved
    }

    # --- UNDER the cap but nothing converted it: ASK, don't park -----------------------------------
    # Distinct from the oversize decision: here the mailbox COULD become shared, so "convert it" is a
    # real third answer. The case that forced this: a client whose profile configures no conversion at
    # all (exchange.offboard = null), where the old "convert the mailbox, then re-run this step" is
    # advice nobody can act on — every re-run reproduced the warning and the seat was never reclaimed.
    It 'ASKS when the mailbox is under the cap but was never converted' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 2.74
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'DECISION_NEEDED:mailbox_not_converted \|.*sizeGB=2.74 \| thresholdGB=50'
        ($r.Actions -join ' ') | Should -Match 'WARN license KEPT .* NOT converted to shared'   # the human twin
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED:mailbox_oversize'          # under the cap: not that question
    }

    # The size is the app's injected mailboxSizeGB, absent (param stays $null) exactly when Exchange
    # could not READ it. It must not be reported as "0 GB": the report keys the Convert button off this,
    # and Exchange refuses to convert a mailbox it cannot prove is under the cap — so offering Convert
    # on an unknown size would be a button guaranteed to fail.
    It 'reports an unreadable mailbox size as unknown, not as 0' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config
        ($r.Actions -join ' ') | Should -Match 'DECISION_NEEDED:mailbox_not_converted \|.*sizeGB=unknown \| thresholdGB=50'
    }

    # The inverse guard: a genuinely EMPTY mailbox is a real, known 0.00 GB — under the cap and
    # convertible. The old 0-sentinel conflated it with "unreadable", so the picker hid the Convert
    # answer for exactly the mailboxes that are cheapest to convert.
    It 'reports a real 0 GB mailbox as sizeGB=0, not unknown' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 0
        ($r.Actions -join ' ') | Should -Match 'DECISION_NEEDED:mailbox_not_converted \|.*sizeGB=0 \| thresholdGB=50'
        ($r.Actions -join ' ') | Should -Not -Match 'sizeGB=unknown'
    }

    It 'removes the license when the operator answered "remove" on the not-converted decision' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }
                                     mailboxConverted = $false; mailboxNotConvertedPolicy = 'remove' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 2.74
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'license removed by operator decision'
        ($r.Actions -join ' ') | Should -Match 'Exchange will DELETE it'
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED'   # answered — never ask twice
        # A decided, executed outcome is a SUCCESS, not a warning: run-report promotes a succeeded step
        # to the "warning" verdict on any /\bWARN\b/ action, which would park this case at "warning"
        # forever with nothing left for anyone to do.
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'
        # …and it must NOT borrow the oversize reason: 2.74 GB is nowhere near the 50 GB cap, and that
        # sentence would go into an AuditLog row and a ServiceNow work note as a falsehood.
        ($r.Actions -join ' ') | Should -Not -Match 'over the 50 GB cap'
    }

    It 'keeps the license and the mailbox, and stops asking, when the operator answered "keep"' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }
                                     mailboxConverted = $false; mailboxNotConvertedPolicy = 'keep' }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 2.74
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'license KEPT by operator decision'
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED'
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'   # decided is a success, not a warning
    }

    # The 'convert' answer carries NO policy — it is executed by re-queuing the Exchange step with
    # convertToShared, and this step just sees the conversion on its own re-run. Pinned because the
    # temptation to add a third policy value here is exactly how a second source of truth starts.
    It 'removes the license once a re-queued convert has landed, with no policy of its own' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{}; mailbox = [pscustomobject]@{ sizeThresholdGB = 50 }; mailboxConverted = $true }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 2.74
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Not -Match 'DECISION_NEEDED'
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'
    }

    # --- the per-client opt-out -------------------------------------------------------------------
    It 'removes the license on an unconverted mailbox when the client allows it, and says the mail will go' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{ allowWithoutConvert = $true }; mailboxConverted = $false }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'this client is configured to allow it \(removeLicense.allowWithoutConvert\)'
        # The mail being destroyed is still said, loudly and in full — it just isn't said as a WARN.
        # The client has ALREADY answered this question, standingly, by configuring the opt-out; there
        # is nothing here for a human to decide, so it must not read as an open one.
        ($r.Actions -join ' ') | Should -Match 'Exchange will DELETE this mailbox'
        ($r.Actions -join ' ') | Should -Match 'not recoverable'
        ($r.Actions -join ' ') | Should -Not -Match 'WARN'
    }

    It 'the opt-out also skips the still-pending convert guard' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{ allowWithoutConvert = $true }; mailboxConvertPending = $true }
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10 | Out-Null
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
    }

    It 'the opt-out does NOT make a converted mailbox report a purge' {
        # The warning is about mail that is actually going to be destroyed. On a mailbox that DID
        # convert, printing it would be a lie that trains people to ignore the real one.
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{ allowWithoutConvert = $true }; mailboxConverted = $true }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Not -Match 'PURGE this mailbox'
    }

    # A cloud-only client with no Exchange step never gets the key at all — it must behave as before.
    It 'removes the license when there is no Exchange step to report a conversion' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{} }
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10 | Out-Null
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
    }

    # --- defer: "not here — a later step removes it" -----------------------------------------------
    # MarketScience's profile says exactly this, and it was IGNORED: {defer=$true} is not $null, so the
    # old `-ne $null` check stripped the license in the very step the profile forbade.
    It 'honours removeLicense.defer — the license is NOT removed in this step' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{ defer = $true; removedBy = 'entra' } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10 -SystemKey 'm365'
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'removed in the entra step'
    }

    It 'removedBy names the step that DOES remove it — the entra lane proceeds' {
        $config = [pscustomobject]@{ removeLicense = [pscustomobject]@{ removedBy = 'entra' }; mailboxConverted = $true }
        Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -MailboxSizeGB 10 -SystemKey 'entra' | Out-Null
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
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

Describe 'Resolve-CtgEntraGroupId' {
    It 'resolves a display name to the group id' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = 'grp-42'; DisplayName = 'E5 License Users' }) }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId 'E5 License Users' }
        $r.Id | Should -Be 'grp-42'
    }

    It 'passes a verified GUID through unchanged' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99' } }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99' }
        $r.Id | Should -Be '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99'
        Should -Invoke Get-MgGroup -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99' } -Times 1
    }

    It 'errors actionably on a stale GUID (Graph 404)' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { throw 'Request_ResourceNotFound: does not exist' }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99' }
        $r.Error | Should -Match 'not found in Entra'
        $r.Error | Should -Match 'configure the group NAME'
    }

    It 'errors on an unknown name with a discovery hint' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @() }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId 'No Such Group' }
        $r.Error | Should -Match "no Entra group named 'No Such Group'"
    }

    It 'errors on an ambiguous name instead of picking one' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = 'a' }, [pscustomobject]@{ Id = 'b' }) }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId 'Dup Name' }
        $r.Error | Should -Match '2 Entra groups match'
    }

    It 'resolves by mail alias too (same identifier set as the rest of the module)' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith {
            param($GroupId, $Filter)
            if ("$Filter" -match "mail eq 'e5-lic@x\.com'") { @([pscustomobject]@{ Id = 'grp-alias' }) } else { @() }
        }
        $r = & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId 'e5-lic@x.com' }
        $r.Id | Should -Be 'grp-alias'
    }

    It 'THROWS on a transient Graph error during name lookup (retry, not a fake config error)' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { throw 'TooManyRequests: throttled' }
        { & (Get-Module Coretelligent.M365) { Resolve-CtgEntraGroupId 'E5 License Users' } } | Should -Throw -ExpectedMessage '*throttled*'
    }
}

Describe 'group-based license assignment' {
    BeforeEach {
        Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:Skus }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }
        Mock New-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1' } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = 'lic-grp-1' }) }
        Mock Get-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { }
        $script:user = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jdoe@x.com'; FirstName='Jane'; LastName='Doe'; JobTitle=''; MobilePhone=''; UsageLocation='US' }
        $script:pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
    }

    It 'licenses via Entra group membership, never Set-MgUserLicense' {
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='Microsoft 365 E5'; assignVia='group'; group='E5 License Users'; groupSource='entra' }) }
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        $r.Status | Should -Be 'ok'
        ($r.Actions -join '|') | Should -Match "license 'Microsoft 365 E5': member of Entra group 'E5 License Users'"
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'lic-grp-1' } -Times 1
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'still sets usageLocation for a group-based-only license list (group licensing requires it)' {
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E5'; assignVia='group'; group='E5 License Users' }) }
        $null = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UsageLocation -eq 'US' } -Times 1
    }

    It 'notes an ad-source entry for the AD lane and touches no Graph group' {
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E3'; assignVia='group'; group='M365 E3 Users Group'; groupSource='ad' }) }
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        ($r.Actions -join '|') | Should -Match "the active-directory step adds it"
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'WARNs (does not fail) when the license group is not in Entra — a config error, no point retrying' {
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @() }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E5'; assignVia='group'; group='Ghost Group' }) }
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        $r.Status | Should -Be 'ok'
        ($r.Actions -join '|') | Should -Match "WARN license 'E5': no Entra group named 'Ghost Group'"
    }

    It 'THROWS (fails the job) when the group add itself fails — same invariant as direct Set-MgUserLicense' {
        Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { throw 'Insufficient privileges to complete the operation' }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E5'; assignVia='group'; group='E5 License Users' }) }
        { Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd } |
            Should -Throw -ExpectedMessage "*could not add to Entra group 'E5 License Users'*"
    }

    It 'mixes group-based and direct entries — direct still uses Set-MgUserLicense' {
        $config = [pscustomobject]@{ licenses = @(
            'SPE_E3',
            [pscustomobject]@{ name='Microsoft 365 E5'; assignVia='group'; group='E5 License Users' }
        ) }
        $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword $pwd
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'lic-grp-1' } -Times 1
    }

    It 'validator: entra group-based entry passes on membership, without any sku' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ AdditionalProperties = @{ displayName = 'E5 License Users' } }) }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='Microsoft 365 E5'; assignVia='group'; group='E5 License Users' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -like "license: Microsoft 365 E5 (via Entra group*" }).pass | Should -BeTrue
    }

    It 'validator: entra group-based entry misses when not a member' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E5'; assignVia='group'; group='E5 License Users' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeFalse
        ($r.checks | Where-Object { $_.name -like "license: E5 (via Entra group*" }).pass | Should -BeFalse
    }

    It 'validator: a GUID-configured entra group verifies by membership ID (not the name index)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = '7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99'; AdditionalProperties = @{ displayName = 'E5 License Users' } }) }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E5'; assignVia='group'; group='7a3d4bce-dbdb-4f13-83ff-6ed2440b6c99' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'validator: ad-source entry passes once the synced membership is visible in Entra' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @([pscustomobject]@{ Id = 'g1'; AdditionalProperties = @{ displayName = 'M365 E3 Users Group' } }) }
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E3'; assignVia='group'; group='M365 E3 Users Group'; groupSource='ad' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -like "license: E3 (via AD group*" }).pass | Should -BeTrue
    }

    It 'validator: ad-source entry MISSES when the group is synced to Entra but the user is not a member' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        # BeforeEach's Get-MgGroup mock returns a group -> the group IS visible in Entra.
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E3'; assignVia='group'; group='M365 E3 Users Group'; groupSource='ad' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeFalse
        ($r.checks | Where-Object { $_.name -like "license: E3 (via AD group*" }).pass | Should -BeFalse
    }

    It 'validator: ad-source entry reports an unverifiable-from-here pass when the group is not visible in Entra' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { $null }  # not synced / on-prem only
        $config = [pscustomobject]@{ licenses = @([pscustomobject]@{ name='E3'; assignVia='group'; group='M365 E3 Users Group'; groupSource='ad' }) }
        $r = Confirm-CtgM365 -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $config -Action 'onboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -like "*not visible in Entra*" }).pass | Should -BeTrue
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
        # 'e5-group' is a NAME — it resolves to the mocked group's id ('g') before the add.
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'g' } -Times 1
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
        Should -Invoke New-MgGroupMember -ModuleName Coretelligent.M365 -ParameterFilter { $GroupId -eq 'g' } -Times 1
    }
}

Describe 'Invoke-CtgM365PasswordReset' {
    # Ad-hoc "Generate random password" (INC0855142): app-generated value arrives as
    # config.newPassword; the executor sets a PasswordProfile with force-change and never
    # echoes the value into the result.
    BeforeEach {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ newPassword = 'Xy7#kQ9pLm2$Wn4v' }
    }

    It 'sets a PasswordProfile with force-change on the resolved user' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jdoe@x.com'; OnPremisesSyncEnabled = $false } }
        $r = Invoke-CtgM365PasswordReset -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter {
            $UserId -eq 'u1' -and $PasswordProfile.Password -eq 'Xy7#kQ9pLm2$Wn4v' -and $PasswordProfile.ForceChangePasswordNextSignIn -eq $true
        }
        ($r | ConvertTo-Json -Depth 6) | Should -Not -Match ([regex]::Escape('Xy7#kQ9pLm2$Wn4v'))
    }

    # FR #14: the operator can untick "require change at next sign-in" (equipment setup logged in
    # as the user). Explicit false only — absent still forces the change.
    It 'honors requireChangeAtSignIn: false (no forced change at next sign-in)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jdoe@x.com'; OnPremisesSyncEnabled = $false } }
        $cfg = [pscustomobject]@{ newPassword = 'Xy7#kQ9pLm2$Wn4v'; requireChangeAtSignIn = $false }
        $r = Invoke-CtgM365PasswordReset -User $user -Config $cfg
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter {
            $PasswordProfile.ForceChangePasswordNextSignIn -eq $false
        }
        ($r.Actions -join ' ') | Should -Match 'NOT required'
    }

    It 'refuses an AD-synced user and points the operator at Active Directory' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jdoe@x.com'; OnPremisesSyncEnabled = $true } }
        { Invoke-CtgM365PasswordReset -User $user -Config $config } | Should -Throw '*AD-synced*'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'throws when the user is not found — never silently no-ops' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { throw 'Request_ResourceNotFound' }
        { Invoke-CtgM365PasswordReset -User $user -Config $config } | Should -Throw '*not found*'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }

    It 'throws when the app did not inject newPassword (a wiped value is never re-usable)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jdoe@x.com'; OnPremisesSyncEnabled = $false } }
        { Invoke-CtgM365PasswordReset -User $user -Config ([pscustomobject]@{}) } | Should -Throw '*newPassword*'
    }

    # UM0028954 (Emporia): Graph gates passwordProfile behind User-PasswordProfile.ReadWrite.All, which
    # nothing asked for before 1.68.0 — so the raw "Insufficient privileges" gave the operator nothing
    # to act on, on a credential whose conn test was green and whose account step had just succeeded.
    Context 'when Graph denies the write for want of a permission' {
        BeforeEach {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jdoe@x.com'; OnPremisesSyncEnabled = $false } }
        }

        It 'names the permission to grant instead of relaying "Insufficient privileges"' {
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { throw '[Authorization_RequestDenied] : Insufficient privileges to complete the operation.' }
            { Invoke-CtgM365PasswordReset -User $user -Config $config } | Should -Throw '*User-PasswordProfile.ReadWrite.All*'
        }

        It 'explains why the account step could succeed on the same credential' {
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { throw '[Authorization_RequestDenied] : Insufficient privileges to complete the operation.' }
            # The distinction that makes the denial make sense: User.ReadWrite.All sets a password while
            # CREATING an account but cannot CHANGE one. Without this sentence the operator sees a step
            # fail on the credential that just provisioned the account and concludes the cred is broken.
            { Invoke-CtgM365PasswordReset -User $user -Config $config } | Should -Throw '*CREATING an account*'
        }

        It 'matches Graph''s other denial shape too (accessDenied / Request Authorization failed)' {
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { throw '[accessDenied] : Request Authorization failed' }
            { Invoke-CtgM365PasswordReset -User $user -Config $config } | Should -Throw '*User-PasswordProfile.ReadWrite.All*'
        }

        It 'never leaks the password into the denial message' {
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { throw '[Authorization_RequestDenied] : Insufficient privileges to complete the operation.' }
            $err = $null
            try { Invoke-CtgM365PasswordReset -User $user -Config $config } catch { $err = [string]$_.Exception.Message }
            $err | Should -Not -Match ([regex]::Escape('Xy7#kQ9pLm2$Wn4v'))
        }

        It 'leaves an unrelated failure alone rather than blaming the permission' {
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { throw 'Service temporarily unavailable' }
            # Still throws (a failed reset is never silent) — but must not send the operator hunting for
            # a permission when Graph was simply unavailable.
            $err = $null
            try { Invoke-CtgM365PasswordReset -User $user -Config $config } catch { $err = [string]$_.Exception.Message }
            $err | Should -BeLike '*temporarily unavailable*'
            $err | Should -Not -BeLike '*PasswordProfile*'
        }
    }
}

Describe 'proxyAddresses conflict feedback' {
    Context 'Test-CtgGraphProxyConflictMessage' {
        It 'recognizes the raw Graph BadRequest wording' {
            InModuleScope Coretelligent.M365 {
                Test-CtgGraphProxyConflictMessage 'Another object with the same value for property proxyAddresses already exists.'
            } | Should -BeTrue
        }
        It 'does not fire on an unrelated error' {
            InModuleScope Coretelligent.M365 {
                Test-CtgGraphProxyConflictMessage 'Insufficient privileges to complete the operation.'
            } | Should -BeFalse
        }
    }

    Context 'Get-CtgProxyAddressConflict' {
        BeforeEach {
            # Default: nothing holds the address anywhere.
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { @() }
            Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @() }
            Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith { @{ value = @() } }
        }

        It 'identifies a live user holding the address (and its disabled state)' {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'proxyAddresses' } -MockWith {
                @([pscustomobject]@{ DisplayName = 'Jane Prior'; UserPrincipalName = 'jane@six-one.com'; AccountEnabled = $false })
            }
            $msg = InModuleScope Coretelligent.M365 { Get-CtgProxyAddressConflict -Address 'jsmith@six-one.com' }
            $msg | Should -BeLike '*existing user*Jane Prior*jane@six-one.com*'
            $msg | Should -BeLike '*disabled*'
        }

        It 'identifies a SOFT-DELETED user (the rehire case) via raw Graph' {
            Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
                @{ value = @(
                    @{ displayName = 'John Rehire'; userPrincipalName = 'jrehire@six-one.com'; proxyAddresses = @('SMTP:jsmith@six-one.com'); mail = 'jsmith@six-one.com'; deletedDateTime = '2026-07-01T00:00:00Z' }
                ) }
            }
            $msg = InModuleScope Coretelligent.M365 { Get-CtgProxyAddressConflict -Address 'smtp:jsmith@six-one.com' }
            $msg | Should -BeLike '*SOFT-DELETED*John Rehire*'
            $msg | Should -BeLike '*Remove-MgDirectoryDeletedItem*'
        }

        It 'identifies a mail-enabled group when no user matches' {
            Mock Get-MgGroup -ModuleName Coretelligent.M365 -ParameterFilter { $Filter -match 'proxyAddresses' } -MockWith {
                @([pscustomobject]@{ DisplayName = 'Sales DL'; Mail = 'sales@six-one.com' })
            }
            $msg = InModuleScope Coretelligent.M365 { Get-CtgProxyAddressConflict -Address 'sales@six-one.com' }
            $msg | Should -BeLike '*mail-enabled group*Sales DL*'
        }

        It 'returns $null when nothing holds it (caller falls back to a generic hint)' {
            $msg = InModuleScope Coretelligent.M365 { Get-CtgProxyAddressConflict -Address 'free@six-one.com' }
            $msg | Should -BeNullOrEmpty
        }

        It 'stays best-effort: a lookup error yields $null, never throws' {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { throw 'graph exploded' }
            Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith { throw 'graph exploded' }
            Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { throw 'graph exploded' }
            $msg = InModuleScope Coretelligent.M365 { Get-CtgProxyAddressConflict -Address 'x@six-one.com' }
            $msg | Should -BeNullOrEmpty
        }
    }

    Context 'onboarding surfaces an actionable alias-collision error' {
        BeforeEach {
            Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $Property -contains 'ProxyAddresses' -or $Property -eq 'ProxyAddresses' } -MockWith {
                [pscustomobject]@{ ProxyAddresses = @() }
            }
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }  # user doesn't exist yet -> create path
            Mock New-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-new' } }
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }      # profile/usageLocation writes ok
            Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
            Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:Skus }
            # The alias write is the one that collides.
            Mock Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $null -ne $ProxyAddresses } -MockWith {
                throw '[Request_BadRequest] : Another object with the same value for property proxyAddresses already exists.'
            }
            # ...and the conflict lookup pins it on a soft-deleted rehire.
            Mock Invoke-MgGraphRequest -ModuleName Coretelligent.M365 -MockWith {
                @{ value = @(@{ displayName = 'John Rehire'; userPrincipalName = 'jrehire@six-one.com'; proxyAddresses = @('SMTP:alias@six-one.com'); mail = 'alias@six-one.com' }) }
            }
            Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { @() }
        }

        It 'replaces the raw BadRequest with who-holds-it detail' {
            $user = [pscustomobject]@{ DisplayName = 'New Hire'; FirstName = 'New'; LastName = 'Hire'; UserPrincipalName = 'nhire@six-one.com' }
            $config = [pscustomobject]@{ alias = [pscustomobject]@{ enabled = $true; address = 'alias@six-one.com' } }
            $err = $null
            try { Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword (ConvertTo-SecureString 'P@ssw0rd!23456' -AsPlainText -Force) } catch { $err = [string]$_.Exception.Message }
            $err | Should -BeLike "*alias 'alias@six-one.com' can't be added*"
            $err | Should -BeLike '*SOFT-DELETED*John Rehire*'
        }
    }
}

Describe 'license service-plan dependency handling' {
    BeforeAll {
        # GUIDs from the real error: THREAT_INTELLIGENCE (Defender for O365 P2) depends on Exchange plans.
        $script:MDO  = '8e0c0a52-6a6c-4d40-8370-dd62790dcd70'
        $script:EXO2 = 'efb87545-963c-4e0d-99df-69c6916d9eb0'
        $script:DEPMSG = "License assignment failed because service plan $script:MDO depends on the service plan(s) 4a82b400-a79f-41a4-b4e2-e94f5787b113,$script:EXO2,9aaf7827-d63c-4b61-89c3-182f06f82e5c"
        # A tenant catalog: E3 carries Exchange Online P2; the Defender add-on carries MDO P2.
        $script:DepSkus = @(
            [pscustomobject]@{ SkuId = 'sku-e3';  SkuPartNumber = 'SPE_E3';         ServicePlans = @([pscustomobject]@{ ServicePlanId = $script:EXO2; ServicePlanName = 'EXCHANGE_S_ENTERPRISE' }) }
            [pscustomobject]@{ SkuId = 'sku-atp'; SkuPartNumber = 'ATP_ENTERPRISE'; ServicePlans = @([pscustomobject]@{ ServicePlanId = $script:MDO;  ServicePlanName = 'THREAT_INTELLIGENCE' }) }
        )
    }

    Context 'Get-CtgLicenseDependencyInfo' {
        It 'parses the dependent plan and its prerequisites out of the raw Graph message' {
            $info = InModuleScope Coretelligent.M365 -Parameters @{ M = $script:DEPMSG } { param($M) Get-CtgLicenseDependencyInfo $M }
            $info.Plan | Should -Be '8e0c0a52-6a6c-4d40-8370-dd62790dcd70'
            @($info.Requires).Count | Should -Be 3
            $info.Requires | Should -Contain 'efb87545-963c-4e0d-99df-69c6916d9eb0'
        }
        It 'returns $null for an unrelated error' {
            InModuleScope Coretelligent.M365 { Get-CtgLicenseDependencyInfo 'Subscription does not have any available licenses.' } | Should -BeNullOrEmpty
        }
    }

    Context 'Invoke-CtgM365LicenseHealingAssign' {
        It 'assigns in one call when there is no dependency problem' {
            Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:DepSkus }
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
            $res = InModuleScope Coretelligent.M365 {
                Invoke-CtgM365LicenseHealingAssign -UserId 'u1' -SkuSpecs @(@{ SkuId = 'sku-e3'; Name = 'E3' })
            }
            $res.Ok | Should -BeTrue
            @($res.Issues).Count | Should -Be 0
            Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1 -Exactly
        }

        It 'disables the unsatisfiable dependent plan, retries, and reports the issue' {
            Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:DepSkus }
            # First attempt (no disabled plans) fails the dependency; the retry with MDO disabled succeeds.
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -ParameterFilter {
                -not (@($AddLicenses) | Where-Object { $_.DisabledPlans -contains '8e0c0a52-6a6c-4d40-8370-dd62790dcd70' })
            } -MockWith { throw $script:DEPMSG }
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -ParameterFilter {
                @($AddLicenses) | Where-Object { $_.DisabledPlans -contains '8e0c0a52-6a6c-4d40-8370-dd62790dcd70' }
            } -MockWith { }
            $res = InModuleScope Coretelligent.M365 {
                Invoke-CtgM365LicenseHealingAssign -UserId 'u1' -SkuSpecs @(@{ SkuId = 'sku-atp'; Name = 'Defender for O365 P2' })
            }
            $res.Ok | Should -BeTrue
            @($res.Issues).Count | Should -Be 1
            $res.Issues[0].PlanName   | Should -Be 'Microsoft Defender for Office 365 (Plan 2)'
            $res.Issues[0].SkuName    | Should -Be 'Defender for O365 P2'
            ($res.Issues[0].RequiresNames -join ' ') | Should -Match 'Exchange Online'
            $res.Issues[0].Resolution | Should -Match 'retry the license assignment'
        }

        It 'hands a NON-dependency failure back unhealed (so seat/usage diagnostics still fire)' {
            Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:DepSkus }
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { throw 'Subscription with SKU cbdc14ab does not have any available licenses.' }
            $res = InModuleScope Coretelligent.M365 {
                Invoke-CtgM365LicenseHealingAssign -UserId 'u1' -SkuSpecs @(@{ SkuId = 'sku-atp'; Name = 'Defender' })
            }
            $res.Ok | Should -BeFalse
            $res.Error | Should -Not -BeNullOrEmpty
            @($res.Issues).Count | Should -Be 0
        }
    }

    Context 'onboarding surfaces held-back plans on the result (Six One scenario)' {
        BeforeEach {
            Mock Get-MgSubscribedSku -ModuleName Coretelligent.M365 -MockWith { $script:DepSkus }
            Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { $null }   # create path
            Mock New-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-new' } }
            Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
            Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }  # nothing assigned yet
            Mock Get-MgGroup -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'grp-1' } }
            Mock Get-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { @() }
            Mock New-MgGroupMember -ModuleName Coretelligent.M365 -MockWith { }
            # The batch (E3 + Defender together) has Exchange enabled, so it SUCCEEDS unless MDO is enabled
            # WITHOUT any Exchange plan. Simulate the real failure: E3's Exchange is absent from the call
            # that carries MDO -> dependency error until MDO is disabled.
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -ParameterFilter {
                (@($AddLicenses) | Where-Object { $_.SkuId -eq 'sku-atp' -and -not ($_.DisabledPlans -contains '8e0c0a52-6a6c-4d40-8370-dd62790dcd70') })
            } -MockWith { throw $script:DEPMSG }
            Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        }

        It 'still assigns the licenses, and reports the held-back Defender plan + LicenseIncomplete' {
            $user = [pscustomobject]@{ DisplayName = 'New Hire'; FirstName = 'New'; LastName = 'Hire'; UserPrincipalName = 'nhire@six-one.com'; UsageLocation = 'US' }
            $config = [pscustomobject]@{ licenses = @(
                [pscustomobject]@{ name = 'Microsoft 365 E3'; skuId = 'sku-e3' }
                [pscustomobject]@{ name = 'Microsoft Defender for Office 365 (Plan 2)'; skuId = 'sku-atp' }
            ) }
            $r = Invoke-CtgM365Onboarding -User $user -Config $config -InitialPassword (ConvertTo-SecureString 'P@ssw0rd!23456' -AsPlainText -Force)
            $r.Status | Should -Be 'ok'                       # non-fatal — the account + base license still land
            $r.LicenseIncomplete | Should -BeTrue
            @($r.LicenseDependencyIssues).Count | Should -BeGreaterThan 0
            $r.LicenseDependencyIssues[0].PlanName | Should -Be 'Microsoft Defender for Office 365 (Plan 2)'
            ($r.Actions -join ' ') | Should -Match 'couldn.t be enabled'
        }
    }
}

Describe 'Invoke-CtgM365Offboarding admin-account (-a) sweep' {
    BeforeEach {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { }
        Mock Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserRegisteredDevice -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Update-MgDevice -ModuleName Coretelligent.M365 -MockWith { }
        Mock Get-MgUserAuthenticationMethod -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgUserManager -ModuleName Coretelligent.M365 -MockWith { $null }
        Mock Remove-MgUserManagerByRef -ModuleName Coretelligent.M365 -MockWith { }
    }

    It 'disables the -a account the same way when it exists' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { "$Filter" -match 'jdoe-a@x\.com' } -MockWith {
            [pscustomobject]@{ Id = 'uid-a'; UserPrincipalName = 'jdoe-a@x.com'; AccountEnabled = $true }
        }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; adminAccountSuffix = '-a' }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        $r.UserId | Should -Be 'uid-1'   # the primary stays authoritative on the result
        ($r.Actions -join "`n") | Should -Match 'admin account check: found jdoe-a@x\.com'
        ($r.Actions -join "`n") | Should -Match '\[jdoe-a@x\.com\]'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 2 -Exactly -ParameterFilter { $AccountEnabled -eq $false }
        Should -Invoke Revoke-MgUserSignInSession -ModuleName Coretelligent.M365 -Times 2 -Exactly
    }

    It 'reports plainly when there is no -a account, and never offers candidates for it' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { "$Filter" -match 'jdoe-a@x\.com' } -MockWith { $null }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true; adminAccountSuffix = '-a' }) -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        ($r.Actions -join "`n") | Should -Match 'admin account check: no jdoe-a@x\.com'
        $r.PSObject.Properties['Candidates'] | Should -BeNullOrEmpty
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $AccountEnabled -eq $false }
    }

    It 'strips the license/mailbox/OneDrive machinery from the -a pass' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { "$Filter" -match 'jdoe-a@x\.com' } -MockWith {
            [pscustomobject]@{ Id = 'uid-a'; UserPrincipalName = 'jdoe-a@x.com'; AccountEnabled = $true }
        }
        $cfg = [pscustomobject]@{ blockSignIn = $true; adminAccountSuffix = '-a'; removeLicense = [pscustomobject]@{}; oneDriveBackup = [pscustomobject]@{ target = 'archives@x.com' } }
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config $cfg -MailboxSizeGB 10
        $r.Status | Should -Be 'ok'
        # the -a pass must never mention license or OneDrive work — those keys are not passed down
        ($r.Actions -join "`n") | Should -Not -Match '\[jdoe-a@x\.com\].*(license|DECISION|OneDrive)'
    }

    It 'does nothing extra when adminAccountSuffix is not configured' {
        $r = Invoke-CtgM365Offboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ blockSignIn = $true }) -MailboxSizeGB 10
        ($r.Actions -join "`n") | Should -Not -Match 'admin account'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $AccountEnabled -eq $false }
    }
}

Describe 'ConvertTo-CtgGraphAttributeName' {
    It 'translates the LDAP spellings operators actually use' {
        InModuleScope Coretelligent.M365 {
            ConvertTo-CtgGraphAttributeName -Name 'title'                      | Should -Be 'JobTitle'
            ConvertTo-CtgGraphAttributeName -Name 'mobile'                     | Should -Be 'MobilePhone'
            ConvertTo-CtgGraphAttributeName -Name 'company'                    | Should -Be 'CompanyName'
            ConvertTo-CtgGraphAttributeName -Name 'physicalDeliveryOfficeName' | Should -Be 'OfficeLocation'
            ConvertTo-CtgGraphAttributeName -Name 'telephoneNumber'            | Should -Be 'BusinessPhones'
            ConvertTo-CtgGraphAttributeName -Name 'l'                          | Should -Be 'City'
            ConvertTo-CtgGraphAttributeName -Name 'st'                         | Should -Be 'State'
            ConvertTo-CtgGraphAttributeName -Name 'co'                         | Should -Be 'Country'
        }
    }

    It 'passes valid Graph names through, case-insensitively' {
        InModuleScope Coretelligent.M365 {
            ConvertTo-CtgGraphAttributeName -Name 'department'   | Should -Be 'Department'
            ConvertTo-CtgGraphAttributeName -Name 'streetAddress'| Should -Be 'StreetAddress'
            ConvertTo-CtgGraphAttributeName -Name 'PostalCode'   | Should -Be 'PostalCode'
            ConvertTo-CtgGraphAttributeName -Name 'jobtitle'     | Should -Be 'JobTitle'
        }
    }

    It 'returns null for attributes with no writable Graph equivalent' {
        InModuleScope Coretelligent.M365 {
            foreach ($n in @('extensionAttribute4','msDS-cloudExtensionAttribute1','proxyAddresses',
                             'ipPhone','homePhone','description','mail','countryCode','usernamePattern')) {
                ConvertTo-CtgGraphAttributeName -Name $n | Should -BeNullOrEmpty -Because "$n is not settable via Update-MgUser"
            }
        }
    }

    It 'maps every attribute Breakthrough Energy Ventures has configured' {
        InModuleScope Coretelligent.M365 {
            foreach ($n in @('city','state','title','mobile','company','country',
                             'department','postalCode','streetAddress','physicalDeliveryOfficeName')) {
                ConvertTo-CtgGraphAttributeName -Name $n | Should -Not -BeNullOrEmpty -Because "core397 configured $n"
            }
        }
    }
}

Describe 'Resolve-CtgM365AttributeUpdate' {
    It 'builds a splattable Graph update from an LDAP-named map' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ title='Analyst'; company='BEV'; city='Boston' }
            $r.Update['JobTitle']    | Should -Be 'Analyst'
            $r.Update['CompanyName'] | Should -Be 'BEV'
            $r.Update['City']        | Should -Be 'Boston'
            $r.Update.Count          | Should -Be 3
        }
    }

    It 'accepts a JSON-deserialized pscustomobject as well as a hashtable' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes ([pscustomobject]@{ title='Analyst' })
            $r.Update['JobTitle'] | Should -Be 'Analyst'
        }
    }

    It 'drops empty values and unresolved {token} strings' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ title=''; department='  '; city='{location.city}'; state='MA' }
            $r.Update.Count    | Should -Be 1
            $r.Update['State'] | Should -Be 'MA'
        }
    }

    It 'lifts manager out of the map instead of sending it to Update-MgUser' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ manager='Jim Goodmiller'; title='Analyst' }
            $r.Manager                     | Should -Be 'Jim Goodmiller'
            $r.Update.ContainsKey('Manager') | Should -BeFalse
            $r.Update['JobTitle']          | Should -Be 'Analyst'
        }
    }

    It 'reports unmappable attributes by name rather than dropping them silently' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ extensionAttribute4='X'; proxyAddresses='smtp:a@b.com'; title='Analyst' }
            $r.Skipped        | Should -Contain 'extensionAttribute4'
            $r.Skipped        | Should -Contain 'proxyAddresses'
            $r.Update.Count   | Should -Be 1
        }
    }

    It 'wraps businessPhones in an array, because Graph types it as a collection' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ telephoneNumber='+1 555 0100' }
            ,$r.Update['BusinessPhones'] | Should -BeOfType [System.Object[]]
            $r.Update['BusinessPhones'][0] | Should -Be '+1 555 0100'
        }
    }

    It 'returns an empty result for a null map' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes $null
            $r.Update.Count  | Should -Be 0
            $r.Manager       | Should -BeNullOrEmpty
            @($r.Skipped).Count | Should -Be 0
        }
    }
}
