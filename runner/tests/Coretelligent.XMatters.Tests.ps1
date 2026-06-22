#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.XMatters. Mocks the HTTP seam (Invoke-CtgXMattersApi).
# Onboard CREATES a Standard User (targetName = email local part, webLogin = full email) + email
# device. Offboard DEACTIVATES by default / DELETES on config.delete; idempotent; resolves the person
# by targetName, else display name.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.XMatters/Coretelligent.XMatters.psm1" -Force
}

Describe 'Invoke-CtgXMattersOnboarding' {
    It 'creates a Standard User: targetName = local part, webLogin = full email, + a Work Email device' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/people/ekent*') { throw 'xMatters API: GET … -> HTTP 404' } # doesn't exist yet
            if ($Method -eq 'POST' -and $Path -eq '/people') { return [pscustomobject]@{ id = 'p9'; targetName = 'ekent' } }
            return $null # POST /devices
        }
        $u = [pscustomobject]@{ UserPrincipalName = 'ekent@core.tech'; FirstName = 'Evan'; LastName = 'Kent' }
        $r = Invoke-CtgXMattersOnboarding -User $u -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -Times 1 -ParameterFilter {
            $Method -eq 'POST' -and $Path -eq '/people' -and
            $Body.targetName -eq 'ekent' -and $Body.webLogin -eq 'ekent@core.tech' -and
            $Body.firstName -eq 'Evan' -and $Body.lastName -eq 'Kent' -and (@($Body.roles) -contains 'Standard User')
        }
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -Times 1 -ParameterFilter {
            $Method -eq 'POST' -and $Path -eq '/devices' -and $Body.deviceType -eq 'EMAIL' -and $Body.emailAddress -eq 'ekent@core.tech' -and $Body.owner -eq 'p9'
        }
        ($r.Actions -join ' ') | Should -Match 'created xMatters person: ekent'
    }

    It 'is idempotent — skips create when the person already exists' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/people/ekent*') { return [pscustomobject]@{ id = 'p9'; targetName = 'ekent'; status = 'ACTIVE' } }
            return $null
        }
        $r = Invoke-CtgXMattersOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'ekent@core.tech'; FirstName = 'Evan'; LastName = 'Kent' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already exists'
    }

    It 'honours a custom role + site from config' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { throw 'HTTP 404' }
            if ($Method -eq 'POST' -and $Path -eq '/people') { return [pscustomobject]@{ id = 'p9' } }
            return $null
        }
        Invoke-CtgXMattersOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'ekent@core.tech'; FirstName = 'Evan'; LastName = 'Kent' }) -Config ([pscustomobject]@{ role = 'Full Access User'; site = 'Boston'; addEmailDevice = $false }) | Out-Null
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -Times 1 -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/people' -and (@($Body.roles) -contains 'Full Access User') -and $Body.site -eq 'Boston' }
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Path -eq '/devices' } -Times 0 -Exactly
    }
}

Describe 'Invoke-CtgXMattersOffboarding' {
    It 'deactivates the person by default (status=INACTIVE), resolved by targetName' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/people/jdoe*') { return [pscustomobject]@{ id = 'p1'; targetName = 'jdoe'; status = 'ACTIVE' } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/people' -and $Body.status -eq 'INACTIVE' -and $Body.id -eq 'p1' } -Times 1
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'deactivated xMatters'
    }

    It 'deletes only when config.delete is set' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/people/jdoe*') { return [pscustomobject]@{ id = 'p1'; targetName = 'jdoe'; status = 'ACTIVE' } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ delete = $true })
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/people/p1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'deleted xMatters'
    }

    It 'is idempotent — no change when already inactive' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/people/jdoe*') { return [pscustomobject]@{ id = 'p1'; targetName = 'jdoe'; status = 'INACTIVE' } }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already inactive'
    }

    It 'is a no-op when the person is not in xMatters (404)' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { throw 'xMatters API: GET … -> HTTP 404' }
            return $null
        }
        $r = Invoke-CtgXMattersOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -ParameterFilter { $Method -ne 'GET' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Confirm-CtgXMatters' {
    It 'offboard: passes when inactive' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ id = 'p1'; targetName = 'jdoe'; status = 'INACTIVE' } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: passes when absent (404)' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { throw 'HTTP 404' }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }
    It 'offboard: fails when still active' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ id = 'p1'; targetName = 'jdoe'; status = 'ACTIVE' } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeFalse
    }
    It 'onboard: passes when the person was created' {
        Mock Invoke-CtgXMattersApi -ModuleName Coretelligent.XMatters -MockWith { [pscustomobject]@{ id = 'p9'; targetName = 'ekent'; status = 'ACTIVE' } }
        (Confirm-CtgXMatters -User ([pscustomobject]@{ UserPrincipalName = 'ekent@core.tech' }) -Config ([pscustomobject]@{}) -Action 'onboard').ok | Should -BeTrue
    }
}
