BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psd1" -Force }
Describe 'Invoke-CtgGoogleChange' {
    BeforeEach {
        Mock -CommandName Get-CtgGoogleUserGroups -ModuleName Coretelligent.GoogleWorkspace -MockWith { @('existing@x.com') }
        Mock -CommandName Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { $null }
    }
    It 'adds a new group and skips an existing one' {
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @('sales@x.com','existing@x.com'); removeGroups = @() })
        $r.Actions -join ';' | Should -Match 'added to group: sales@x.com'
        $r.Actions -join ';' | Should -Match 'already in group: existing@x.com'
    }
    It 'removes a named group the user is in' {
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @(); removeGroups = @('existing@x.com') })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' } -Times 1
        $r.Actions -join ';' | Should -Match 'removed from group: existing@x.com'
    }
    It 'skips removing a named group the user is not in' {
        Mock -CommandName Get-CtgGoogleUserGroups -ModuleName Coretelligent.GoogleWorkspace -MockWith { @('other@x.com') }
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @(); removeGroups = @('existing@x.com') })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' } -Times 0
        $r.Actions -join ';' | Should -Not -Match 'removed from group: existing@x.com'
    }
    It 'reconciles: removes a current group not in desiredGroups' {
        Mock -CommandName Get-CtgGoogleUserGroups -ModuleName Coretelligent.GoogleWorkspace -MockWith { @('keep@x.com', 'drop@x.com') }
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @(); removeGroups = @(); reconcileGroups = $true; desiredGroups = @('keep@x.com') })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/groups/drop@x.com/members/jdoe@x.com' } -Times 1
        $r.Actions -join ';' | Should -Match 'removed from group: drop@x.com'
        $r.Actions -join ';' | Should -Not -Match 'removed from group: keep@x.com'
    }
    It 'warns (not a false success) when an add throws' {
        Mock -CommandName Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' } -MockWith { throw 'boom' }
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @('sales@x.com'); removeGroups = @() })
        $r.Actions -join ';' | Should -Match 'WARN could not add to group sales@x.com'
        $r.Actions -join ';' | Should -Not -Match 'added to group: sales@x.com'
    }
    It 'warns (not a false success) when a remove throws' {
        Mock -CommandName Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' } -MockWith { throw 'boom' }
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @(); removeGroups = @('existing@x.com') })
        $r.Actions -join ';' | Should -Match 'WARN could not remove from group existing@x.com'
        $r.Actions -join ';' | Should -Not -Match 'removed from group: existing@x.com'
    }
}
