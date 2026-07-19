#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Coretelligent.SharePoint — connection tests (Task 4) + Grant-CtgSharePointSiteAccess and
# Get-CtgOneDriveSiteUrl tests (Task 5). PnP.PowerShell isn't installed here (fail-soft — see
# $pnpAvail in Start-IamRunner.ps1), so we stub the PnP cmdlets before mocking them, same pattern as
# Coretelligent.Exchange.Tests.ps1 stubbing the EXO V3 cmdlets.

BeforeAll {
    function global:Connect-PnPOnline { [CmdletBinding()] param($Url, $ClientId, $Tenant, $CertificatePath, $CertificatePassword, $Thumbprint) }
    function global:Add-PnPSiteCollectionAdmin { [CmdletBinding()] param($Owners) }
    function global:Get-PnPSiteCollectionAdmin { [CmdletBinding()] param() }
    # Test-CtgDelegateUnambiguous (offboard-review Fix 5) calls Get-MgUser directly for the
    # display-name ambiguity check — stub it the same way Coretelligent.M365.Tests.ps1 does.
    function global:Get-MgUser { param($UserId, $Filter, [switch]$All, $ConsistencyLevel, $Property, $Top) }
    # Invoke-CtgSharePointOffboardGrant (offboard-review Fix 2) calls Resolve-CtgEntraUser,
    # Resolve-CtgM365Upn and Get-CtgUserDrive, which live in Coretelligent.M365 — import the .psm1
    # directly (not the .psd1) so the manifest's Microsoft.Graph RequiredModules (not installed here)
    # don't block the import; same pattern as Coretelligent.M365.Tests.ps1. All three are mocked below,
    # so none of their own Graph dependencies need to be real.
    Import-Module "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psm1" -Force
    Import-Module "$PSScriptRoot/../modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psd1" -Force
}

Describe 'Connect-CtgSharePointPnP' {
    BeforeEach { Mock -CommandName Connect-PnPOnline -ModuleName Coretelligent.SharePoint -MockWith { } }

    It 'connects app-only with a base64 cert (writes a temp pfx, passes ClientId+Tenant)' {
        Connect-CtgSharePointPnP -Url 'https://x.sharepoint.com/sites/s' -AppId 'app-id' -Tenant 'x.onmicrosoft.com' -CertificateBase64 ([Convert]::ToBase64String([byte[]](1..10)))
        Should -Invoke Connect-PnPOnline -ModuleName Coretelligent.SharePoint -Times 1 -ParameterFilter { $ClientId -eq 'app-id' -and $Tenant -eq 'x.onmicrosoft.com' -and $Url -eq 'https://x.sharepoint.com/sites/s' }
    }

    It 'throws a clear error when no cert form is provided' {
        { Connect-CtgSharePointPnP -Url 'https://x/s' -AppId 'a' -Tenant 't' } | Should -Throw
    }
}

Describe 'Grant-CtgSharePointSiteAccess' {
    BeforeEach {
        Mock -CommandName Connect-CtgSharePointPnP -ModuleName Coretelligent.SharePoint -MockWith { }
        Mock -CommandName Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { }
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @() }
    }
    It 'adds the delegate as a site collection admin' {
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x.sharepoint.com/sites/s' -Delegate 'amelia@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 1
        $r | Should -Match 'granted amelia@x.com site-collection admin'
    }
    It 'is idempotent when already an admin' {
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Email = 'amelia@x.com' }) }
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x/s' -Delegate 'amelia@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 0
        $r | Should -Match 'already'
    }
    It 'does NOT treat a lookalike email (substring) as already-admin — grants the real delegate' {
        # bsmith@x.com contains "smith@x.com": a -like "*$Delegate*" match would wrongly call this
        # "already admin" and skip the grant entirely. Exact match must reject this and still add.
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Email = 'bsmith@x.com' }) }
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x/s' -Delegate 'smith@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 1
        $r | Should -Match 'granted smith@x.com site-collection admin'
    }
    It 'is idempotent on an exact-match email (still no false negative)' {
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Email = 'smith@x.com' }) }
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x/s' -Delegate 'smith@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 0
        $r | Should -Match 'already'
    }
    It 'matches a claims-format LoginName (i:0#.f|membership|user@x.com) when Email is empty' {
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Email = ''; LoginName = 'i:0#.f|membership|smith@x.com' }) }
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x/s' -Delegate 'smith@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 0
        $r | Should -Match 'already'
    }
}

Describe 'Get-CtgOneDriveSiteUrl' {
    It 'strips the document-library path down to the /personal/<user> site root' {
        Get-CtgOneDriveSiteUrl 'https://x-my.sharepoint.com/personal/a_b_com/Documents/f' | Should -Be 'https://x-my.sharepoint.com/personal/a_b_com'
    }
    It 'leaves a bare site root unchanged' {
        Get-CtgOneDriveSiteUrl 'https://x-my.sharepoint.com/personal/a_b_com' | Should -Be 'https://x-my.sharepoint.com/personal/a_b_com'
    }
    It 'returns $null for a non-OneDrive URL' {
        Get-CtgOneDriveSiteUrl 'https://x.sharepoint.com/sites/s' | Should -BeNullOrEmpty
    }
    It 'returns $null for an empty URL' {
        Get-CtgOneDriveSiteUrl '' | Should -BeNullOrEmpty
    }
}

# offboard-review Fix 1 (SECURITY): Invoke-CtgM365Offboarding (Coretelligent.M365.psm1) returns
# Status='ok' having done NOTHING when the leaver's name is ambiguous (2+ matches), a near-miss (no
# exact match but candidates), or matches nobody at all — every one of those early returns omits
# UserId; only the real teardown path (past `$existing = ...`) sets it. This is the discriminator the
# m365 Offboard dispatch block in Start-IamRunner.ps1 gates the SharePoint hand-off on.
Describe 'Test-CtgOffboardResolved' {
    It 'is $false for $null' {
        Test-CtgOffboardResolved $null | Should -BeFalse
    }
    It 'is $false for the ambiguous-match early return (no UserId, has CandidateReason)' {
        $r = [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = 'jgoodmiller@x.com'; Actions = @('WARN 2 users match...'); Candidates = @(); CandidateQuery = 'James Goodmiller'; CandidateReason = 'ambiguous'; Evidence = @{ Groups = @(); Devices = @() } }
        Test-CtgOffboardResolved $r | Should -BeFalse
    }
    It 'is $false for the no-match early return (no UserId, has CandidateReason)' {
        $r = [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = ''; Actions = @('WARN no exact match...'); Candidates = @(); CandidateQuery = 'Parth Shah'; CandidateReason = 'no-match'; Evidence = @{ Groups = @(); Devices = @() } }
        Test-CtgOffboardResolved $r | Should -BeFalse
    }
    It 'is $false for the user-not-found early return (no UserId, no CandidateReason either)' {
        $r = [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = ''; Actions = @('user not found (nobody) — nothing to offboard'); Evidence = @{ Groups = @(); Devices = @() } }
        Test-CtgOffboardResolved $r | Should -BeFalse
    }
    It 'is $false when UserId is present but blank' {
        $r = [pscustomobject]@{ System = 'm365'; Status = 'ok'; UserId = ''; Upn = ''; Actions = @() }
        Test-CtgOffboardResolved $r | Should -BeFalse
    }
    It 'is $true for a genuinely resolved-and-acted offboard' {
        $r = [pscustomobject]@{ System = 'm365'; Status = 'ok'; UserId = 'aaaa-bbbb'; Upn = 'jdoe@x.com'; Evidence = @{ Groups = @(); Devices = @(); MfaMethods = @() }; Manager = $null; RetryAfterMinutes = $null; Actions = @('blocked sign-in') }
        Test-CtgOffboardResolved $r | Should -BeTrue
    }
}

# offboard-review Fix 2: oneDriveGrantAccessTo may be a DISPLAY NAME (ServiceNow intake), which
# Add-PnPSiteCollectionAdmin -Owners cannot use — it needs an email/UPN. Invoke-CtgSharePointOffboardGrant
# must resolve it via Resolve-CtgEntraUser BEFORE calling Grant-CtgSharePointSiteAccess.
Describe 'Invoke-CtgSharePointOffboardGrant' {
    BeforeEach {
        Mock -CommandName Resolve-CtgEntraUser -ModuleName Coretelligent.SharePoint -MockWith { [pscustomobject]@{ Mail = 'amelia@x.com'; UserPrincipalName = 'amelia@x.com' } }
        Mock -CommandName Resolve-CtgM365Upn -ModuleName Coretelligent.SharePoint -MockWith { $null }
        Mock -CommandName Get-CtgUserDrive -ModuleName Coretelligent.SharePoint -MockWith { $null }
        Mock -CommandName Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -MockWith { "granted $Delegate site-collection admin on $SiteUrl" }
    }

    It 'resolves a display-name delegate to an email BEFORE granting SharePoint site access' {
        $job = [pscustomobject]@{
            payload = [pscustomobject]@{}
            config  = [pscustomobject]@{ oneDriveGrantAccessTo = 'Amelia Jones'; sharePointDelegateSites = @('https://x.sharepoint.com/sites/finance') }
        }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 'x.onmicrosoft.com' -CertArgs @{ CertificateBase64 = 'Yg==' }

        Should -Invoke Resolve-CtgEntraUser -ModuleName Coretelligent.SharePoint -Times 1 -ParameterFilter { $Identity -eq 'Amelia Jones' }
        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 1 -ParameterFilter { $Delegate -eq 'amelia@x.com' -and $SiteUrl -eq 'https://x.sharepoint.com/sites/finance' }
        $actions | Should -Contain 'granted amelia@x.com site-collection admin on https://x.sharepoint.com/sites/finance'
    }

    It 'WARNs and skips — never hands PnP a bare display name — when the delegate cannot be resolved in Entra' {
        Mock -CommandName Resolve-CtgEntraUser -ModuleName Coretelligent.SharePoint -MockWith { $null }
        $job = [pscustomobject]@{ payload = [pscustomobject]@{}; config = [pscustomobject]@{ oneDriveGrantAccessTo = 'Nobody Here' } }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 0
        $actions | Should -Match "WARN.*Nobody Here.*not found"
    }

    It 'does nothing (and never resolves) when no delegate is configured' {
        $job = [pscustomobject]@{ payload = [pscustomobject]@{}; config = [pscustomobject]@{} }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        $actions.Count | Should -Be 0
        Should -Invoke Resolve-CtgEntraUser -ModuleName Coretelligent.SharePoint -Times 0
    }

    # offboard-review Fix 5 (SECURITY): Resolve-CtgEntraUser's own display-name lookup is `-Top 1` — an
    # ambiguous name (2+ "Chris Lee"s) would otherwise silently resolve to whichever ONE Graph returns,
    # who then gets FULL CONTROL of the leaver's OneDrive/SharePoint site. The SharePoint hand-off must
    # fail safe (skip + WARN) rather than grant off a guess.
    It 'fails safe — skips the grant and WARNs — when a display-name delegate matches 2+ Entra users' {
        Mock -CommandName Get-MgUser -ModuleName Coretelligent.SharePoint -MockWith {
            @([pscustomobject]@{ Id = 'u1'; DisplayName = 'Chris Lee' }, [pscustomobject]@{ Id = 'u2'; DisplayName = 'Chris Lee' })
        }
        $job = [pscustomobject]@{
            payload = [pscustomobject]@{}
            config  = [pscustomobject]@{ oneDriveGrantAccessTo = 'Chris Lee'; sharePointDelegateSites = @('https://x.sharepoint.com/sites/finance') }
        }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        Should -Invoke Get-MgUser -ModuleName Coretelligent.SharePoint -Times 1 -ParameterFilter { $Filter -match "displayName eq 'Chris Lee'" -and $Top -eq 2 }
        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 0
        $actions | Should -Match "WARN.*Chris Lee.*matches multiple users"
    }

    It 'proceeds without an ambiguity query when the delegate is already an email/UPN' {
        Mock -CommandName Get-MgUser -ModuleName Coretelligent.SharePoint -MockWith { throw 'ambiguity check should not run for an exact email/UPN identifier' }
        $job = [pscustomobject]@{
            payload = [pscustomobject]@{}
            config  = [pscustomobject]@{ oneDriveGrantAccessTo = 'amelia@x.com'; sharePointDelegateSites = @('https://x.sharepoint.com/sites/finance') }
        }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        Should -Invoke Get-MgUser -ModuleName Coretelligent.SharePoint -Times 0
        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 1
        $actions | Should -Contain 'granted amelia@x.com site-collection admin on https://x.sharepoint.com/sites/finance'
    }

    It 'proceeds when a display-name delegate matches exactly one Entra user' {
        Mock -CommandName Get-MgUser -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Id = 'u1'; DisplayName = 'Amelia Jones' }) }
        $job = [pscustomobject]@{
            payload = [pscustomobject]@{}
            config  = [pscustomobject]@{ oneDriveGrantAccessTo = 'Amelia Jones'; sharePointDelegateSites = @('https://x.sharepoint.com/sites/finance') }
        }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 1
        $actions | Should -Contain 'granted amelia@x.com site-collection admin on https://x.sharepoint.com/sites/finance'
    }

    It 'grants the resolved email on every configured SharePoint site, WARNing per-site on failure with the Graph error, not a bare exception message' {
        Mock -CommandName Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -MockWith {
            if ($SiteUrl -eq 'https://x.sharepoint.com/sites/bad') { throw [System.Exception]::new('{"error":{"code":"itemNotFound","message":"site not found"}}') }
            "granted $Delegate site-collection admin on $SiteUrl"
        }
        $job = [pscustomobject]@{
            payload = [pscustomobject]@{}
            config  = [pscustomobject]@{ oneDriveGrantAccessTo = 'amelia@x.com'; sharePointDelegateSites = @('https://x.sharepoint.com/sites/good', 'https://x.sharepoint.com/sites/bad') }
        }
        $actions = Invoke-CtgSharePointOffboardGrant -Job $job -AppId 'app-id' -Tenant 't' -CertArgs @{}

        Should -Invoke Grant-CtgSharePointSiteAccess -ModuleName Coretelligent.SharePoint -Times 2
        $actions | Should -Contain 'granted amelia@x.com site-collection admin on https://x.sharepoint.com/sites/good'
        ($actions | Where-Object { $_ -match 'sites/bad' }) | Should -Match 'WARN'
    }
}

# Fix 1's dispatch-level wiring: Start-IamRunner.ps1 has a mandatory param block and a main polling
# loop, so it cannot be dot-sourced for Pester (see ConnectionCache.Tests.ps1's header comment for the
# same constraint) — assert the wiring textually instead, same technique that file already uses.
Describe 'm365 Offboard dispatch — SharePoint hand-off wiring' {
    BeforeAll {
        $script:Runner = Get-Content "$PSScriptRoot/../Start-IamRunner.ps1" -Raw
        $m = [regex]::Match($script:Runner, "Offboard\s*=\s*\{.*?\n\s*\}\s*\n\s*Change\s*=", 'Singleline')
        $m.Success | Should -BeTrue -Because 'the m365 Offboard dispatch scriptblock must be found (ends right before Change =)'
        $script:OffboardBlock = $m.Value
    }
    It 'checks Test-CtgOffboardResolved before calling Invoke-CtgSharePointOffboardGrant' {
        $iResolved = $script:OffboardBlock.IndexOf('Test-CtgOffboardResolved')
        $iGrant = $script:OffboardBlock.IndexOf('Invoke-CtgSharePointOffboardGrant')
        $iResolved | Should -BeGreaterThan -1
        $iGrant | Should -BeGreaterThan -1
        $iResolved | Should -BeLessThan $iGrant
    }
    It 'never calls Grant-CtgSharePointSiteAccess directly — only through Invoke-CtgSharePointOffboardGrant, which resolves the delegate first' {
        $script:OffboardBlock | Should -Not -Match 'Grant-CtgSharePointSiteAccess'
    }
}
