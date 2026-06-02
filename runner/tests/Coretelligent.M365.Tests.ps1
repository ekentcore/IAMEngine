#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.M365. The Microsoft.Graph cmdlets aren't installed here, so
# we declare thin stubs (BeforeAll) and Mock them in the module scope to assert behavior:
# license-name -> SkuId resolution, idempotent onboarding, and the offboarding branch logic.

BeforeAll {
    # Import the implementation directly so the manifest's RequiredModules (Microsoft.Graph,
    # not installed in CI) don't block unit tests; the Graph cmdlets are mocked below.
    $ModulePath = "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psm1"

    # Global stubs so Pester can Mock these in the module scope (real cmdlets come from Microsoft.Graph).
    function global:Get-MgSubscribedSku {}
    function global:Get-MgUser {}
    function global:New-MgUser {}
    function global:Get-MgUserLicenseDetail {}
    function global:Set-MgUserLicense {}
    function global:Get-MgGroup {}
    function global:Get-MgGroupMember {}
    function global:New-MgGroupMember {}
    function global:Update-MgUser {}
    function global:Get-MgUserMemberOf {}
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
