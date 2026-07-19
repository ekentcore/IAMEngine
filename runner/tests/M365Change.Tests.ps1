#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Invoke-CtgM365Change (the m365/entra change/mover lane): add/remove Entra groups by
# name and add/remove licenses. Mirrors the corrected AD-lane audit-integrity pattern — a REMOVAL that
# throws must produce a WARN action, never a false "removed" line, and an idempotent not-found is a
# benign skip, not a WARN.

BeforeAll {
    $ModulePath = "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psd1"
    Import-Module $ModulePath -Force

    # Helper: build a fake Get-MgUserMemberOf group result shaped like the real Graph SDK object
    # (AdditionalProperties dictionary), matching how Invoke-CtgM365Offboarding's evidence/reconcile
    # code reads it. Defined in BeforeAll (not loose in Describe) so it survives into Pester's Run
    # phase, not just Discovery.
    function New-FakeGraphGroup {
        param([string]$Id, [string]$DisplayName, [bool]$OnPrem = $false, [bool]$MailEnabled = $false, [bool]$Dynamic = $false)
        [pscustomobject]@{
            Id                   = $Id
            AdditionalProperties = @{
                '@odata.type'         = '#microsoft.graph.group'
                displayName           = $DisplayName
                onPremisesSyncEnabled = $OnPrem
                mailEnabled           = $MailEnabled
                groupTypes            = if ($Dynamic) { @('DynamicMembership') } else { @() }
            }
        }
    }
}

Describe 'Invoke-CtgM365Change' {
    BeforeEach {
        # Resolve-CtgM365Upn returns a plain UPN STRING (not an object) — confirmed against the real
        # implementation (used elsewhere as `[string](Resolve-CtgM365Upn $User)`), which differs from
        # an earlier draft of this test that assumed an @{Id;UserPrincipalName} shape.
        Mock -CommandName Resolve-CtgM365Upn -ModuleName Coretelligent.M365 -MockWith { 'jdoe@x.com' }
        Mock -CommandName Get-MgUser -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'user-guid'; UserPrincipalName = 'jdoe@x.com' } }
        Mock -CommandName Resolve-CtgEntraGroupId -ModuleName Coretelligent.M365 -MockWith { param($NameOrId) @{ Id = "grp-$NameOrId"; Error = $null } }
        Mock -CommandName Add-CtgGroupMember -ModuleName Coretelligent.M365 -MockWith { $null }
        Mock -CommandName Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { }
        Mock -CommandName Resolve-CtgSkuId -ModuleName Coretelligent.M365 -MockWith { param($License) "sku-$License" }
        Mock -CommandName Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { }
        # Default: no memberships. Reconcile tests override this to return specific groups.
        Mock -CommandName Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { @() }
    }

    It 'adds a group by name via resolve+Add-CtgGroupMember' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @('Sales'); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Add-CtgGroupMember -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'added to group: Sales'
    }

    It 'removes a named group via resolve+Remove-MgGroupMemberByRef' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @('Support') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'removed from group: Support'
    }

    It 'a real removal failure produces a WARN action, not a false "removed" line' {
        Mock -CommandName Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { throw 'Authorization_RequestDenied: Insufficient privileges' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @('Support') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'WARN could not remove from group Support'
        $joined | Should -Not -Match 'removed from group: Support'
    }

    It 'an idempotent not-found removal is a benign skip, not a WARN' {
        Mock -CommandName Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { throw 'Request_ResourceNotFound: Resource does not exist' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @('Support') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'not a member of Support \(skip\)'
        $joined | Should -Not -Match 'WARN'
    }

    It 'adds a license by name/skuId' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @(); licenses = @('E3'); removeLicenses = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'added license: E3'
    }

    It 'removes a license by name/skuId' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @(); licenses = @(); removeLicenses = @('E3') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Set-MgUserLicense -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'removed license: E3'
    }

    It 'a license removal failure produces a WARN, not a false "removed" line' {
        Mock -CommandName Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { throw 'license is inherited from a group membership' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @(); licenses = @(); removeLicenses = @('E3') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'WARN could not remove license E3'
        $joined | Should -Not -Match 'removed license: E3'
    }

    It 'a group add failure produces a failure action, not a false "added" line' {
        Mock -CommandName Add-CtgGroupMember -ModuleName Coretelligent.M365 -MockWith { 'insufficient privileges' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @('Sales'); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'add group Sales failed'
        $joined | Should -Not -Match 'added to group: Sales'
    }

    It 'an unresolvable group name is a WARN and never reaches Add-CtgGroupMember' {
        Mock -CommandName Resolve-CtgEntraGroupId -ModuleName Coretelligent.M365 -MockWith { @{ Id = $null; Error = 'not found' } }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @('Ghost'); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'WARN group not found: Ghost'
        Should -Invoke Add-CtgGroupMember -ModuleName Coretelligent.M365 -Times 0
    }

    It 'a license add failure produces a WARN, not a false "added" line' {
        Mock -CommandName Set-MgUserLicense -ModuleName Coretelligent.M365 -MockWith { throw 'license assignment failed' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @(); licenses = @('E3'); removeLicenses = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'WARN could not add license E3'
        $joined | Should -Not -Match 'added license: E3'
    }

    It 'reconcile removes stale cloud groups not in desiredGroups but keeps desired/on-prem/dynamic ones' {
        $fakeGroups = @(
            (New-FakeGraphGroup -Id 'g-keep' -DisplayName 'Keep-Group'),
            (New-FakeGraphGroup -Id 'g-stale' -DisplayName 'Stale-Group'),
            (New-FakeGraphGroup -Id 'g-onprem' -DisplayName 'OnPrem-Group' -OnPrem $true),
            (New-FakeGraphGroup -Id 'g-dynamic' -DisplayName 'Dynamic-Group' -Dynamic $true)
        )
        Mock -CommandName Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { $fakeGroups }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ reconcileGroups = $true; desiredGroups = @('Keep-Group'); groups = @(); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 1 -ParameterFilter { $GroupId -eq 'g-stale' }
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 0 -ParameterFilter { $GroupId -eq 'g-keep' }
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 0 -ParameterFilter { $GroupId -eq 'g-onprem' }
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 0 -ParameterFilter { $GroupId -eq 'g-dynamic' }
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'removed from group: Stale-Group'
        $joined | Should -Not -Match 'removed from group: Keep-Group'
        $joined | Should -Not -Match 'removed from group: OnPrem-Group'
        $joined | Should -Not -Match 'removed from group: Dynamic-Group'
    }

    It 'reconcile is a no-op when reconcileGroups is not set (unchanged behavior)' {
        $fakeGroups = @( (New-FakeGraphGroup -Id 'g-stale' -DisplayName 'Stale-Group') )
        Mock -CommandName Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { $fakeGroups }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 0
        $r.Actions -join ';' | Should -Not -Match 'removed from group: Stale-Group'
    }

    It 'a reconcile removal failure produces a WARN action, not a false "removed" line' {
        $fakeGroups = @( (New-FakeGraphGroup -Id 'g-stale' -DisplayName 'Stale-Group') )
        Mock -CommandName Get-MgUserMemberOf -ModuleName Coretelligent.M365 -MockWith { $fakeGroups }
        Mock -CommandName Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { throw 'Authorization_RequestDenied: Insufficient privileges' }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ reconcileGroups = $true; desiredGroups = @(); groups = @(); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        $joined = $r.Actions -join ';'
        $joined | Should -Match 'WARN could not remove from group Stale-Group'
        $joined | Should -Not -Match 'removed from group: Stale-Group'
    }

    It 'throws when the target user cannot be resolved in Entra' {
        Mock -CommandName Resolve-CtgM365Upn -ModuleName Coretelligent.M365 -MockWith { '' }
        $u = [pscustomobject]@{ UserPrincipalName = '' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @() }
        { Invoke-CtgM365Change -User $u -Config $c } | Should -Throw
    }
}
