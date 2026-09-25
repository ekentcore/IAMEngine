# FR #0000118: remove a leaver from SharePoint SITE groups on every site, and mirror a reference user's
# site groups on onboard. PnP.PowerShell isn't on a test host, so its cmdlets are thin global stubs,
# mocked in the module scope.
BeforeAll {
    # Advanced (CmdletBinding), as real cmdlets are, so they take -ErrorAction.
    function global:Connect-PnPOnline { [CmdletBinding()] param($Url, $ClientId, $Tenant, $CertificatePath, $CertificatePassword, $Thumbprint) }
    function global:Get-PnPTenantSite { [CmdletBinding()] param() }
    function global:Get-PnPUser { [CmdletBinding()] param($Identity) }
    function global:Get-PnPGroup { [CmdletBinding()] param() }
    function global:Get-PnPGroupMember { [CmdletBinding()] param($Group) }
    function global:Remove-PnPGroupMember { [CmdletBinding()] param($Group, $LoginName) }
    function global:Add-PnPGroupMember { [CmdletBinding()] param($Group, $LoginName) }
    # The runner's global progress poster, and Graph — both called by the module when present.
    function global:Send-CtgProgress { param([string]$Message) }
    function global:Get-MgUser { [CmdletBinding()] param($Filter, $Top, $All, $ConsistencyLevel, $Property, $UserId) }
    Import-Module "$PSScriptRoot/../modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psm1" -Force -DisableNameChecking
    $script:Cert = @{ CertificateThumbprint = 'AB' }
}
AfterAll { Remove-Module Coretelligent.SharePoint -Force -ErrorAction SilentlyContinue }

Describe 'Get-CtgSharePointSiteUrls' {
    It 'lists team/communication sites, drops OneDrives and system sites, and caches per tenant' {
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { }
        Mock Get-PnPTenantSite -ModuleName Coretelligent.SharePoint {
            @(
                [pscustomobject]@{ Url = 'https://contoso.sharepoint.com/sites/Finance'; Template = 'GROUP#0' },
                [pscustomobject]@{ Url = 'https://contoso-my.sharepoint.com/personal/a_contoso_com'; Template = 'SPSPERS#10' },
                [pscustomobject]@{ Url = 'https://contoso.sharepoint.com/search'; Template = 'SRCHCEN#0' },
                [pscustomobject]@{ Url = 'https://contoso.sharepoint.com/sites/HR'; Template = 'SITEPAGEPUBLISHING#0' }
            )
        }
        InModuleScope Coretelligent.SharePoint { $script:CtgSiteCache = @{} }
        $a = Get-CtgSharePointSiteUrls -AdminUrl 'https://contoso-admin.sharepoint.com' -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        $b = Get-CtgSharePointSiteUrls -AdminUrl 'https://contoso-admin.sharepoint.com' -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        $a | Should -Be @('https://contoso.sharepoint.com/sites/Finance', 'https://contoso.sharepoint.com/sites/HR')
        $b | Should -Be $a
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 1 -Exactly
    }
}

Describe 'site groups' {
    BeforeEach {
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { }
        Mock Get-PnPGroup -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ Title = 'Finance Members' }, [pscustomobject]@{ Title = 'Finance Visitors' }, [pscustomobject]@{ Title = 'ChatGPT Pilot' }) }
        # leaver@ and ref@ are on the Finance site (in Members + ChatGPT Pilot); nobody is on the HR site.
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint { if ($script:OnSite -and $Identity -match 'leaver@|ref@') { [pscustomobject]@{ LoginName = $Identity } } }
        Mock Get-PnPGroupMember -ModuleName Coretelligent.SharePoint {
            $t = [string]$Group.Title
            if ($t -in @('Finance Members', 'ChatGPT Pilot')) { @([pscustomobject]@{ LoginName = 'i:0#.f|membership|leaver@contoso.com' }, [pscustomobject]@{ LoginName = 'i:0#.f|membership|ref@contoso.com' }) } else { @() }
        }
        Mock Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
        Mock Add-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
    }
    It 'offboard removes the leaver from every group they are in, and skips a site they never visited' {
        $script:OnSite = $true
        $r = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        Should -Invoke Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
        ($r -join "`n") | Should -Match 'removed leaver@contoso.com from 2 group\(s\) on 1 of 1 site'
        $script:OnSite = $false
        $null = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/HR') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        Should -Invoke Get-PnPGroup -ModuleName Coretelligent.SharePoint -Times 1 -Exactly   # only the first call enumerated groups
    }
    It 'onboard mirrors the reference user''s groups, minus the excluded ones' {
        $script:OnSite = $true
        $r = Invoke-CtgSharePointSiteGroupsMirror -NewEmail 'new@contoso.com' -ReferenceEmail 'ref@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert -Exclude @('ChatGPT*')
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 1 -Exactly -ParameterFilter { $Group -eq 'Finance Members' -and $LoginName -eq 'i:0#.f|membership|new@contoso.com' }
        ($r -join "`n") | Should -Match "not mirrored: site group 'ChatGPT Pilot'"
    }
    It 'one failing site is reported, the rest still run, and the step does not claim success' {
        $script:OnSite = $true
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { if ($Url -match 'Broken') { throw 'Access denied' } }
        { Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Broken', 'https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert } |
            Should -Throw '*1 of 2 site(s)*sites/Broken*Access denied*'
        Should -Invoke Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
    }
}

# Review fixes on PR #111. Each test here failed against the first cut of FR #118.
Describe 'review fixes' {
    BeforeEach {
        $script:OnSite = $true
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { }
        Mock Get-PnPGroup -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ Title = 'Finance Members' }, [pscustomobject]@{ Title = 'ChatGPT Pilot' }) }
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint { if ($script:OnSite -and $Identity -match 'leaver@|ref@') { [pscustomobject]@{ LoginName = $Identity } } }
        Mock Get-PnPGroupMember -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ LoginName = 'i:0#.f|membership|leaver@contoso.com' }, [pscustomobject]@{ LoginName = 'i:0#.f|membership|ref@contoso.com' }) }
        Mock Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
        Mock Add-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
        Mock Send-CtgProgress -ModuleName Coretelligent.SharePoint { }
        Mock Start-Sleep -ModuleName Coretelligent.SharePoint { }
        Mock Get-PnPTenantSite -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ Url = 'https://contoso.sharepoint.com/sites/Finance'; Template = 'GROUP#0' }) }
        Mock Get-MgUser -ModuleName Coretelligent.SharePoint {
            if ($Filter -match 'ref@contoso\.com') { @([pscustomobject]@{ UserPrincipalName = 'ref@contoso.com'; DisplayName = 'Rita Ref' }) }
            elseif ($Filter -match "displayName eq 'Rita Ref'") { @([pscustomobject]@{ UserPrincipalName = 'ref@contoso.com'; DisplayName = 'Rita Ref' }) }
            elseif ($Filter -match "displayName eq 'Sam Twin'") { @([pscustomobject]@{ UserPrincipalName = 'sam1@contoso.com' }, [pscustomobject]@{ UserPrincipalName = 'sam2@contoso.com' }) }
        }
        InModuleScope Coretelligent.SharePoint { $script:CtgSiteCache = @{} }
        $script:Ctx = { @{ AppId = 'app'; Tenant = 'contoso.com'; CertArgs = @{ CertificateThumbprint = 'AB' }; AdminUrl = 'https://contoso-admin.sharepoint.com' } }
    }

    # Finding 2: a big tenant walked with no narration tripped the runner's 600 s stall watchdog.
    It 'posts progress while it walks the sites' {
        $script:OnSite = $false
        $sites = @(1..25 | ForEach-Object { "https://contoso.sharepoint.com/sites/S$_" })
        $null = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites $sites -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        Should -Invoke Send-CtgProgress -ModuleName Coretelligent.SharePoint -Times 3
        $null = Invoke-CtgSharePointSiteGroupsMirror -NewEmail 'new@contoso.com' -ReferenceEmail 'ref@contoso.com' -Sites $sites -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        Should -Invoke Send-CtgProgress -ModuleName Coretelligent.SharePoint -Times 6
    }

    # Finding 3: a lookup error read as "never on this site" — the offboard reported success.
    It 'a lookup error on a site fails the offboard instead of reading as "not on this site"' {
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint { throw 'Access is denied. (Exception from HRESULT: 0x80070005)' }
        { Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert } |
            Should -Throw '*may still have access*sites/Finance*Access is denied*'
    }
    It 'a user who is genuinely not on the site is still a quiet skip' {
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint { throw 'User cannot be found.' }
        $r = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        ($r -join "`n") | Should -Match 'removed leaver@contoso.com from 0 group\(s\) on 0 of 1 site'
    }
    It 'throttling (429/503) is retried, not skipped' {
        $global:SpUserCalls = 0
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint {
            $global:SpUserCalls++
            if ($global:SpUserCalls -eq 1) { throw 'The remote server returned an error: (429) Too Many Requests.' }
            else { [pscustomobject]@{ LoginName = $Identity } }
        }
        $r = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert
        Should -Invoke Start-Sleep -ModuleName Coretelligent.SharePoint -Times 1 -Exactly
        Should -Invoke Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
        ($r -join "`n") | Should -Match 'from 2 group\(s\) on 1 of 1 site'
    }
    It 'a group-member read error is an error too, not an empty group' {
        Mock Get-PnPGroupMember -ModuleName Coretelligent.SharePoint { throw 'The remote server returned an error: (500) Internal Server Error.' }
        { Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites @('https://contoso.sharepoint.com/sites/Finance') -AppId 'app' -Tenant 'contoso.com' -CertArgs $script:Cert } |
            Should -Throw '*sites/Finance*500*'
    }

    # Finding 5: in a dry run the WhatIf preference also stopped the temp .pfx (a private key) being
    # deleted, and a fresh copy was written for every site.
    It 'a dry run writes the certificate once and deletes it' {
        $global:SpCertPaths = [System.Collections.Generic.List[string]]::new()
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { $global:SpCertPaths.Add([string]$CertificatePath) }
        $pfx = @{ CertificateBase64 = [Convert]::ToBase64String([byte[]](1, 2, 3)) }
        $sites = @('https://contoso.sharepoint.com/sites/A', 'https://contoso.sharepoint.com/sites/B', 'https://contoso.sharepoint.com/sites/C')
        try {
            $global:WhatIfPreference = $true
            $null = Invoke-CtgSharePointSiteGroupsOffboard -Email 'leaver@contoso.com' -Sites $sites -AppId 'app' -Tenant 'contoso.com' -CertArgs $pfx
        }
        finally {
            $global:WhatIfPreference = $false
            $leftover = @($global:SpCertPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
            foreach ($f in $leftover) { [System.IO.File]::Delete($f) }
        }
        $global:SpCertPaths.Count | Should -Be 3
        @($global:SpCertPaths | Select-Object -Unique).Count | Should -Be 1
        $leftover.Count | Should -Be 0
        Should -Invoke Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }

    # Finding 7: no mirror user = nothing to do; don't touch PnP, the cert, or the site list at all.
    It 'onboard with no mirror user is a no-op that never builds the SharePoint context' {
        $global:SpCtxCalls = 0
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ UserPrincipalName = 'new@contoso.com' }) -Config ([pscustomobject]@{}) -Context { $global:SpCtxCalls++; throw 'PnP is not installed' }
        $r.Status | Should -Be 'ok'
        ($r.Actions -join "`n") | Should -Match 'no mirror user'
        $global:SpCtxCalls | Should -Be 0
        Should -Invoke Connect-PnPOnline -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }

    # Finding 1: the m365 step creates the hire at a FALLBACK username when the primary belongs to
    # someone else — the mirror must land on the account it actually created, never on the primary.
    It 'onboard mirrors onto the account the m365 step created (provisionedUpn), not the primary candidate' {
        $p = [pscustomobject]@{ UserPrincipalName = 'jsmith@contoso.com'; UserPrincipalNameFallbacks = @('john.smith2@contoso.com'); provisionedUpn = 'john.smith2@contoso.com' }
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
        $r.Email | Should -Be 'john.smith2@contoso.com'
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly -ParameterFilter { $LoginName -eq 'i:0#.f|membership|john.smith2@contoso.com' }
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly -ParameterFilter { $LoginName -match 'jsmith@' }
    }
    It 'no cloud step: several username candidates refuse, naming the field to set' {
        $p = [pscustomobject]@{ UserPrincipalName = 'jsmith@contoso.com'; UserPrincipalNameFallbacks = @('john.smith2@contoso.com'); accountRule = 'no-cloud-step' }
        { Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx } |
            Should -Throw '*which account*Set Username (userPrincipalName) on the case*'
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }
    It 'no cloud step, or a manual/scim step by plan: the sole candidate is used' {
        foreach ($rule in 'no-cloud-step', 'planned-manual') {
            $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ UserPrincipalName = 'new@contoso.com'; accountRule = $rule }) -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
            $r.Email | Should -Be 'new@contoso.com'
        }
    }
    It 'planned-manual prefers the operator-set Username the app confirmed, even with fallbacks' {
        $p = [pscustomobject]@{ UserPrincipalName = 'john.smith2@contoso.com'; UserPrincipalNameFallbacks = @('jsmith@contoso.com'); accountRule = 'planned-manual'; confirmedUpn = 'john.smith2@contoso.com' }
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
        $r.Email | Should -Be 'john.smith2@contoso.com'
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly -ParameterFilter { $LoginName -eq 'i:0#.f|membership|john.smith2@contoso.com' }
    }
    # Review 4: jsmith@ is John Smith's; m365 failed on it, the operator accepted the failure and made
    # jsmith2@ by hand WITHOUT editing Username. The sole candidate is John — it must never be used.
    It 'operator-required never falls back to the sole-candidate primary, and says which field and why' {
        $p = [pscustomobject]@{
            UserPrincipalName = 'jsmith@contoso.com'; accountRule = 'operator-required'; confirmedUpn = $null
            accountReason = "the m365 step didn't report the account it created (its failure was accepted)"
            fieldSource = [pscustomobject]@{ userPrincipalName = 'operator' }   # set, but not confirmed fresh by the app
        }
        { Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx } |
            Should -Throw "*failure was accepted*jsmith@contoso.com*belongs to someone else*Set Username (userPrincipalName) on the case*after the Microsoft 365 step last ran*"
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }
    It 'operator-required uses the Username the app confirmed was set after the step last ran' {
        $p = [pscustomobject]@{ UserPrincipalName = 'jsmith2@contoso.com'; accountRule = 'operator-required'; confirmedUpn = 'jsmith2@contoso.com' }
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
        $r.Email | Should -Be 'jsmith2@contoso.com'
    }
    It 'the provisioned account always wins' {
        $p = [pscustomobject]@{ UserPrincipalName = 'jsmith@contoso.com'; provisionedUpn = 'john.smith2@contoso.com'; accountRule = 'reported'; confirmedUpn = 'other@contoso.com' }
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
        $r.Email | Should -Be 'john.smith2@contoso.com'
    }

    # Finding 4: the mirror user was resolved by display name with -Top 1 — two people, arbitrary pick.
    It 'a mirror user named by a display name two people share fails with a clear message' {
        { Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ UserPrincipalName = 'new@contoso.com'; provisionedUpn = 'new@contoso.com' }) -Config ([pscustomobject]@{ mirrorFromUser = 'Sam Twin' }) -Context $script:Ctx } |
            Should -Throw '*2 or more people*Sam Twin*email*'
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }
    It 'a mirror user named by a unique display name resolves to their UPN' {
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ UserPrincipalName = 'new@contoso.com'; provisionedUpn = 'new@contoso.com' }) -Config ([pscustomobject]@{ mirrorFromUser = 'Rita Ref' }) -Context $script:Ctx
        ($r.Actions -join "`n") | Should -Match 'mirrored 2 group\(s\) from ref@contoso.com'
    }

    # Finding 6: the mirror policy's exclude list (config.mirrorPolicy.exclude) reaches the step and is honoured.
    It 'the step honours config.mirrorPolicy.exclude' {
        $cfg = [pscustomobject]@{ mirrorFromUser = 'ref@contoso.com'; mirrorPolicy = [pscustomobject]@{ exclude = @('chatgpt*') } }
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ UserPrincipalName = 'new@contoso.com'; provisionedUpn = 'new@contoso.com' }) -Config $cfg -Context $script:Ctx
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 1 -Exactly -ParameterFilter { $Group -eq 'Finance Members' }
        ($r.Actions -join "`n") | Should -Match "not mirrored: site group 'ChatGPT Pilot'"
    }

    It 'offboard removes the leaver it is given, building the context only then' {
        $r = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane offboard -Payload ([pscustomobject]@{}) -LeaverUpn 'leaver@contoso.com' -Context $script:Ctx
        $r.Status | Should -Be 'ok'
        Should -Invoke Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
    }
}

# Second review of PR #111.
Describe 'second review fixes' {
    BeforeEach {
        $global:SpNewSite = $false
        Mock Connect-PnPOnline -ModuleName Coretelligent.SharePoint { }
        Mock Get-PnPGroup -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ Title = 'Finance Members' }) }
        Mock Get-PnPUser -ModuleName Coretelligent.SharePoint { if ($Identity -match 'leaver@|ref@') { [pscustomobject]@{ LoginName = $Identity } } }
        Mock Get-PnPGroupMember -ModuleName Coretelligent.SharePoint { @([pscustomobject]@{ LoginName = 'i:0#.f|membership|leaver@contoso.com' }, [pscustomobject]@{ LoginName = 'i:0#.f|membership|ref@contoso.com' }) }
        Mock Remove-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
        Mock Add-PnPGroupMember -ModuleName Coretelligent.SharePoint { }
        Mock Send-CtgProgress -ModuleName Coretelligent.SharePoint { }
        # Finance always exists; NewProject appears once $global:SpNewSite is set (created mid-cache-window).
        Mock Get-PnPTenantSite -ModuleName Coretelligent.SharePoint {
            @([pscustomobject]@{ Url = 'https://contoso.sharepoint.com/sites/Finance'; Template = 'GROUP#0' })
            if ($global:SpNewSite) { [pscustomobject]@{ Url = 'https://contoso.sharepoint.com/sites/NewProject'; Template = 'GROUP#0' } }
        }
        Mock Get-MgUser -ModuleName Coretelligent.SharePoint { if ($Filter -match 'ref@contoso\.com') { @([pscustomobject]@{ UserPrincipalName = 'ref@contoso.com' }) } }
        InModuleScope Coretelligent.SharePoint { $script:CtgSiteCache = @{} }
        $script:Ctx = { @{ AppId = 'app'; Tenant = 'contoso.com'; CertArgs = @{ CertificateThumbprint = 'AB' }; AdminUrl = 'https://contoso-admin.sharepoint.com' } }
    }

    # N1: a single-pattern client whose primary jsmith@ is an EXISTING John Smith, with m365 paused on a
    # collision decision. No provisionedUpn yet and no fallbacks, so the first cut mirrored onto him.
    It 'onboard waits for the created account while the case has a cloud-account step, even with one candidate' {
        foreach ($p in @(
                [pscustomobject]@{ UserPrincipalName = 'jsmith@contoso.com'; accountRule = 'wait'; provisionedUpn = $null },
                [pscustomobject]@{ UserPrincipalName = 'jsmith@contoso.com' })) {   # flag absent (older app) = wait too
            { Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload $p -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx } |
                Should -Throw '*waiting for the Microsoft 365 step*'
        }
        Should -Invoke Add-PnPGroupMember -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }

    # N2: a site created inside the 6 h cache window was never walked on offboard.
    It 'offboard always lists sites fresh (and refreshes the cache); onboard may reuse it' {
        $null = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane offboard -Payload ([pscustomobject]@{}) -LeaverUpn 'leaver@contoso.com' -Context $script:Ctx
        $global:SpNewSite = $true
        $null = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane offboard -Payload ([pscustomobject]@{}) -LeaverUpn 'leaver@contoso.com' -Context $script:Ctx
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
        Should -Invoke Connect-PnPOnline -ModuleName Coretelligent.SharePoint -Times 1 -Exactly -ParameterFilter { $Url -match 'NewProject' }
        # That fresh listing refreshed the cache, so an onboard mirror right after reuses it: no third listing.
        $null = Invoke-CtgSharePointSiteGroupsStep -InProcess -Lane onboard -Payload ([pscustomobject]@{ provisionedUpn = 'new@contoso.com' }) -Config ([pscustomobject]@{ mirrorFromUser = 'ref@contoso.com' }) -Context $script:Ctx
        Should -Invoke Get-PnPTenantSite -ModuleName Coretelligent.SharePoint -Times 2 -Exactly
        Should -Invoke Connect-PnPOnline -ModuleName Coretelligent.SharePoint -Times 2 -Exactly -ParameterFilter { $Url -match 'NewProject' }
    }
}

# The site walk is PnP, and PnP must never load in the runner: its identity assemblies clash with
# Microsoft.Graph's and Graph stops answering (#121). So the step runs the walk in a child pwsh. These
# tests start REAL child processes; a stand-in module supplies Invoke-CtgSharePointSiteGroupsWalk, so
# no PnP is needed and every child outcome (success, failure, crash, hang) can be produced for real.
Describe 'the site walk runs out of process' {
    BeforeAll {
        $script:FakeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-spwalk-test-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:FakeDir | Out-Null
        # A module whose walk runs $Body; the walk's parameters are in scope for it.
        $script:FakeWalk = {
            param([string]$Name, [string]$Body)
            $f = Join-Path $script:FakeDir "$Name.psm1"
            $head = 'function Invoke-CtgSharePointSiteGroupsWalk { [CmdletBinding(SupportsShouldProcess)] param($Lane, $Email, $ReferenceEmail, [string[]]$Exclude, $AppId, $Tenant, [hashtable]$CertArgs, $AdminUrl, [AllowEmptyCollection()][string[]]$Sites, [switch]$NoCache, [scriptblock]$OnSites)'
            Set-Content -LiteralPath $f -Encoding utf8 -Value ($head + "`n" + $Body + "`n}")
            $f
        }
        $script:Walk = { param([string]$Lane = 'offboard') @{ Lane = $Lane; Email = 'leaver@contoso.com'; AppId = 'app'; Tenant = "t-$([guid]::NewGuid().ToString('N'))"; CertArgs = @{ CertificateBase64 = 'U0VDUkVU'; CertificatePassword = 'pw' }; AdminUrl = 'https://contoso-admin.sharepoint.com'; NoCache = ($Lane -eq 'offboard') } }
    }
    AfterAll { Remove-Item -LiteralPath $script:FakeDir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'the step hands the walk to the child — never the in-process walk — with the resolved people' {
        Mock Invoke-CtgSharePointSiteWalkOutOfProcess -ModuleName Coretelligent.SharePoint { @("removed from site group 'Finance Members' on https://x/sites/A") }
        Mock Invoke-CtgSharePointSiteGroupsWalk -ModuleName Coretelligent.SharePoint { throw 'must not walk in-process' }
        $ctx = { @{ AppId = 'app'; Tenant = 'contoso.onmicrosoft.com'; CertArgs = @{ CertificateThumbprint = 'AB' }; AdminUrl = 'https://contoso-admin.sharepoint.com' } }
        $r = Invoke-CtgSharePointSiteGroupsStep -Lane offboard -Payload ([pscustomobject]@{}) -LeaverUpn 'leaver@contoso.com' -Context $ctx
        $r.Actions | Should -Contain "removed from site group 'Finance Members' on https://x/sites/A"
        Should -Invoke Invoke-CtgSharePointSiteWalkOutOfProcess -ModuleName Coretelligent.SharePoint -Times 1 -Exactly -ParameterFilter {
            $Walk.Lane -eq 'offboard' -and $Walk.Email -eq 'leaver@contoso.com' -and $Walk.NoCache -eq $true -and $Walk.CertArgs.CertificateThumbprint -eq 'AB'
        }
        Should -Invoke Invoke-CtgSharePointSiteGroupsWalk -ModuleName Coretelligent.SharePoint -Times 0 -Exactly
    }

    It 'the runner never asks for the in-process walk' {
        (Get-Content "$PSScriptRoot/../Start-IamRunner.ps1" -Raw) | Should -Not -Match 'Invoke-CtgSharePointSiteGroupsStep[^\r\n]*-InProcess'
    }

    It 'relays the child''s progress live, returns its actions, and leaves no request file behind' {
        Mock Send-CtgProgress -ModuleName Coretelligent.SharePoint { }
        $m = & $script:FakeWalk 'ok' @'
if ($CertArgs.CertificateBase64 -ne 'U0VDUkVU') { throw 'certificate did not arrive' }
Send-CtgProgress "removing $Email from site groups on 2 site(s)"
@("removed from site group 'Finance Members' on https://x/sites/A (it's done)", "SharePoint site groups: removed $Email from 1 group(s) on 1 of 2 site(s)")
'@
        $before = @(Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'ctg-spwalk-*' -Directory | Where-Object Name -NotLike 'ctg-spwalk-test-*').Count
        $r = Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m
        $r | Should -Be @("removed from site group 'Finance Members' on https://x/sites/A (it's done)", 'SharePoint site groups: removed leaver@contoso.com from 1 group(s) on 1 of 2 site(s)')
        Should -Invoke Send-CtgProgress -ModuleName Coretelligent.SharePoint -ParameterFilter { $Message -eq 'removing leaver@contoso.com from site groups on 2 site(s)' } -Times 1 -Exactly
        @(Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter 'ctg-spwalk-*' -Directory | Where-Object Name -NotLike 'ctg-spwalk-test-*').Count | Should -Be $before
    }

    It 'keeps the per-tenant site cache in the runner: an onboard after an offboard reuses the listed sites' {
        $m = & $script:FakeWalk 'cache' @'
if ($null -eq $Sites) { & $OnSites @('https://x/sites/A', 'https://x/sites/B'); "listed $($NoCache)" } else { "given $($Sites -join ',')" }
'@
        $off = & $script:Walk 'offboard'
        Invoke-CtgSharePointSiteWalkOutOfProcess -Walk $off -ModulePath $m | Should -Be 'listed True'
        $on = & $script:Walk 'onboard'; $on.Tenant = $off.Tenant; $on.ReferenceEmail = 'ref@contoso.com'
        Invoke-CtgSharePointSiteWalkOutOfProcess -Walk $on -ModulePath $m | Should -Be 'given https://x/sites/A,https://x/sites/B'
        # An offboard never takes the cache: it always lists fresh.
        Invoke-CtgSharePointSiteWalkOutOfProcess -Walk $off -ModulePath $m | Should -Be 'listed True'
    }

    It 'a walk that fails reports the walk''s own message' {
        $m = & $script:FakeWalk 'fail' 'throw "SharePoint site groups: couldn''t check or clean up leaver@contoso.com, who may still have access there, on 1 of 3 site(s): https://x/sites/B (Access denied)"'
        { Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m } | Should -Throw '*may still have access there, on 1 of 3 site(s): https://x/sites/B (Access denied)*'
    }

    It 'survives a REAL stack overflow in the child, and says the walk is incomplete' {
        $m = & $script:FakeWalk 'so' 'Add-Type -TypeDefinition "public static class CtgWalkBoom { public static int F(int n) { return F(n + 1) + 1; } }"; [CtgWalkBoom]::F(0)'
        { Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m } | Should -Throw '*crashed (stack overflow in PnP.PowerShell) before finishing*The runner kept running*'
    }

    It 'stops a child that goes quiet, well before the runner''s stall watchdog would' {
        $m = & $script:FakeWalk 'hang' 'Send-CtgProgress "listing SharePoint sites"; Start-Sleep -Seconds 120'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        { Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m -QuietSeconds 4 } | Should -Throw '*went 4 s without reporting anything and was stopped*'
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 60
    }

    It 'the quiet limit sits under the runner''s 600 s stall watchdog' {
        (& (Get-Module Coretelligent.SharePoint) { $script:CtgSpWalkQuietSeconds }) | Should -BeLessThan 600
    }

    It 'a dry run stays a dry run in the child' {
        $m = & $script:FakeWalk 'whatif' 'if ($PSCmdlet.ShouldProcess("x", "remove")) { "changed" } else { "would change" }'
        Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m -WhatIf | Should -Be 'would change'
        Invoke-CtgSharePointSiteWalkOutOfProcess -Walk (& $script:Walk) -ModulePath $m | Should -Be 'changed'
    }

    It 'the real walk runs in a child against the real module (no PnP here, so it reports the missing cmdlet, not a crash)' {
        $real = Join-Path $PSScriptRoot '../modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psd1'
        $w = & $script:Walk; $w.CertArgs = @{ CertificateThumbprint = 'AB' }
        { Invoke-CtgSharePointSiteWalkOutOfProcess -Walk $w -ModulePath $real } | Should -Throw '*Connect-PnPOnline*'
        (Get-Module PnP.PowerShell) | Should -BeNullOrEmpty
    }
}
