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
    function global:Get-MgUser {}
    function global:New-MgUser {}
    function global:Get-MgUserLicenseDetail {}
    function global:Set-MgUserLicense {}
    function global:Get-MgGroup {}
    function global:Get-MgGroupMember {}
    function global:New-MgGroupMember { param($GroupId, $DirectoryObjectId) }
    function global:Update-MgUser {}
    function global:Get-MgUserMemberOf { param($UserId, [switch]$All) }
    function global:Remove-MgGroupMemberByRef {}
    function global:Get-MgUserDefaultDrive {}

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
        ($r.checks | Where-Object { $_.name -eq 'group: Sales' }).pass | Should -BeTrue
    }

    It 'onboard: a missing group fails that check and overall ok' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'uid-1'; AccountEnabled = $true } }
        Mock Get-MgUserLicenseDetail -ModuleName Coretelligent.M365 -MockWith { @() }
        Mock Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $config = [pscustomobject]@{ licenses = @(); groups = @('Sales') }
        $r = Confirm-CtgM365 -User $user -Config $config -Action 'onboard'
        $r.ok | Should -BeFalse
        ($r.checks | Where-Object { $_.name -eq 'group: Sales' }).pass | Should -BeFalse
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
