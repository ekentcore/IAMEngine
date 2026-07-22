#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Slack. Mocks the single HTTP seam (Invoke-CtgSlackScim).
#
# The BEHAVIOUR these pin:
#   onboard  — check by email FIRST, then reactivate-or-create; never a second account for one person
#   offboard — DEACTIVATE (SCIM DELETE, which on Slack switches the account off and keeps the data),
#              and a leaver who never had Slack is a clean no-op, not a failure that blocks the case

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Slack/Coretelligent.Slack.psm1" -Force
}

Describe 'Invoke-CtgSlackOnboarding' {
    It 'creates the account when the user is not in Slack' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @() } }
            return [pscustomobject]@{ id = 'W123' }
        }
        $r = Invoke-CtgSlackOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'new@x.com'; DisplayName = 'New Person' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/Users' -and $Body.userName -eq 'new@x.com' } -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'created a Slack account'
    }

    It 'is idempotent — an already-active member is a no-op (no second account)' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W1'; active = $true }) } }
            return $null
        }
        $r = Invoke-CtgSlackOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'has@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -in @('POST', 'PATCH') } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already has an active'
    }

    # A returning employee: the account exists but is switched off. Creating a NEW one would give them
    # two Slack identities — Slack would happily accept it.
    It 'reactivates a deactivated account instead of creating a duplicate' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W7'; active = $false }) } }
            return $null
        }
        $r = Invoke-CtgSlackOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'back@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'PATCH' -and $Path -eq '/Users/W7' } -Times 1 -Exactly
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'reactivated'
    }

    # "SCIM isn't on your plan" is indistinguishable from a bad token unless we say so — and sending
    # someone to rotate a perfectly good credential is a long, annoying dead end.
    It 'names the plan/scope requirement when SCIM is unavailable, rather than failing opaquely' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { throw 'Response status code HTTP 404 not_found' }
        { Invoke-CtgSlackOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'a@x.com' }) -Config ([pscustomobject]@{}) } |
            Should -Throw -ExpectedMessage '*Business+*'
    }
}

Describe 'Invoke-CtgSlackOffboarding' {
    It 'deactivates the account (SCIM DELETE = switch off, data retained)' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W9'; active = $true }) } }
            return $null
        }
        $r = Invoke-CtgSlackOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'leaver@x.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/Users/W9' } -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'retained'
    }

    It 'is idempotent — an already-deactivated account is a no-op' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            if ($Method -eq 'GET') { return [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W9'; active = $false }) } }
            return $null
        }
        $r = Invoke-CtgSlackOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'gone@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already deactivated'
    }

    # A leaver who never had Slack is normal. Failing here would block the rest of the offboard.
    It 'reports a user who was never in Slack as a clean no-op, not a failure' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @() } }
        $r = Invoke-CtgSlackOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'never@x.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'DELETE' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no Slack account'
    }
}

Describe 'Confirm-CtgSlack' {
    It 'offboard: passes when the account is deactivated' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W1'; active = $false }) } }
        (Confirm-CtgSlack -User ([pscustomobject]@{ UserPrincipalName = 'a@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }

    It 'offboard: FAILS when the account is still active — the honest answer, not a rubber stamp' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W1'; active = $true }) } }
        (Confirm-CtgSlack -User ([pscustomobject]@{ UserPrincipalName = 'a@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeFalse
    }

    # The validator gets the SAME payload as the executor — a UM offboard case has no UserPrincipalName
    # property at all. It used to throw under StrictMode; and simply not-throwing is not enough, because
    # a blank email finds nobody, which the offboard branch reads as "never had Slack" and PASSES.
    It 'offboard: resolves a UM-shaped payload (userToOffboard) rather than throwing' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W1'; active = $false }) } }
        (Confirm-CtgSlack -User ([pscustomobject]@{ userToOffboard = 'a@x.com' }) -Config ([pscustomobject]@{}) -Action 'offboard').ok | Should -BeTrue
    }

    It 'offboard: FAILS (does not rubber-stamp) when the case carries no email to verify against' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @() } }
        $r = Confirm-CtgSlack -User ([pscustomobject]@{ userToOffboard = 'Parth Shah' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
        $r.checks[0].name | Should -Match 'no email/UPN'
    }

    It 'onboard: fails when no account exists' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @() } }
        (Confirm-CtgSlack -User ([pscustomobject]@{ UserPrincipalName = 'a@x.com' }) -Config ([pscustomobject]@{}) -Action 'onboard').ok | Should -BeFalse
    }
}

Describe 'Find-CtgSlackUser' {
    It 'looks the member up by EMAIL (handles collide and change; email does not)' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Path, $Body, $Query)
            [pscustomobject]@{ Resources = @([pscustomobject]@{ id = 'W1'; active = $true }) }
        }
        $u = Find-CtgSlackUser -Email 'a@x.com'
        $u.id | Should -Be 'W1'
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Query.filter -eq 'email eq "a@x.com"' } -Times 1 -Exactly
    }

    It 'returns null (not an error) when nobody matches' {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @() } }
        Find-CtgSlackUser -Email 'nobody@x.com' | Should -BeNullOrEmpty
    }
}

# The seam itself. Every test above MOCKS Invoke-CtgSlackScim, so its body never runs — which is
# exactly where a bug hides until the first real call (an earlier draft assigned to $args, a reserved
# automatic variable). Mock one level deeper, at Invoke-RestMethod, and assert what goes on the wire.
Describe 'Invoke-CtgSlackScim (the HTTP seam itself)' {
    BeforeEach {
        $script:sent = $null
        Mock Invoke-RestMethod -ModuleName Coretelligent.Slack -MockWith {
            param($Method, $Uri, $Headers, $Body, $ContentType, $ErrorAction)
            # Invoke-RestMethod types -Uri as [Uri], and Uri.ToString() UN-escapes for display — so a
            # correctly-encoded request reads back with raw spaces and quotes. OriginalString is what we
            # actually handed it, i.e. what goes on the wire; assert on that or the test lies to you.
            $script:sent = @{ Method = $Method; Uri = $Uri; Wire = $Uri.OriginalString; Headers = $Headers; Body = $Body }
            [pscustomobject]@{ ok = $true }
        }
        Connect-CtgSlack -Token 'xoxp-secret'
    }

    It 'sends a Bearer token to the SCIM base URL' {
        Invoke-CtgSlackScim -Method GET -Path '/Users' | Out-Null
        $script:sent.Uri | Should -Be 'https://api.slack.com/scim/v2/Users'
        $script:sent.Headers.Authorization | Should -Be 'Bearer xoxp-secret'
    }

    It 'URL-encodes the query so an email filter survives the trip intact' {
        Invoke-CtgSlackScim -Method GET -Path '/Users' -Query @{ filter = 'email eq "a b@x.com"' } | Out-Null
        $script:sent.Wire | Should -Match '\?filter='
        $script:sent.Wire | Should -Not -Match '\s'          # no raw spaces on the wire
        $script:sent.Wire | Should -Match '%40'              # the @ is encoded
        $script:sent.Wire | Should -Match '%22'              # so are the filter's quotes
    }

    It 'serializes the body as JSON on a write' {
        Invoke-CtgSlackScim -Method POST -Path '/Users' -Body @{ userName = 'a@x.com' } | Out-Null
        $script:sent.Body | Should -Match '"userName"\s*:\s*"a@x.com"'
    }

    It 'refuses to call anything before Connect-CtgSlack (no anonymous requests)' {
        InModuleScope Coretelligent.Slack { $script:SlackToken = $null }
        { Invoke-CtgSlackScim -Method GET -Path '/Users' } | Should -Throw -ExpectedMessage '*Connect-CtgSlack*'
    }
}

# The email reaches us from a ServiceNow FORM FIELD and is then interpolated into a SCIM filter
# expression. Validate its shape rather than trusting escaping: a trailing backslash would escape the
# closing quote, and an EMPTY value is the dangerous one — `email eq ""` matches nobody, so onboarding
# would sail past its "does this person already exist?" check and create an account with a blank name.
Describe 'Find-CtgSlackUser — untrusted intake email' {
    BeforeEach {
        Mock Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -MockWith { [pscustomobject]@{ Resources = @() } }
    }

    It 'refuses a filter-breaking address instead of querying with it' {
        foreach ($bad in @('a" or userName pr "', 'x\', 'no-at-sign', 'two@@x.com', 'has space@x.com')) {
            { Find-CtgSlackUser -Email $bad } | Should -Throw -ExpectedMessage '*not a usable email address*'
        }
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -Times 0 -Exactly
    }

    It 'refuses an EMPTY address rather than creating a blank-username account' {
        { Invoke-CtgSlackOnboarding -User ([pscustomobject]@{ UserPrincipalName = '' }) -Config ([pscustomobject]@{}) } |
            Should -Throw -ExpectedMessage '*not a usable email address*'
        Should -Invoke Invoke-CtgSlackScim -ModuleName Coretelligent.Slack -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
    }

    It 'still accepts ordinary addresses (including plus-addressing and subdomains)' {
        foreach ($ok in @('a.b@x.com', 'a+tag@sub.x.co.uk')) {
            { Find-CtgSlackUser -Email $ok } | Should -Not -Throw
        }
    }
}

Describe "Resolve-CtgSlackConsoleLogin (browser auto-setup login resolver)" {
    It "accepts an email + password admin login" {
        $r = Resolve-CtgSlackConsoleLogin -Secret ([pscustomobject]@{ Fields = @{ Username = "admin@acme.com"; Password = "pw" } })
        $r.Ok | Should -BeTrue
        $r.Username | Should -Be "admin@acme.com"
    }
    It "refuses when the username is not an email (a SCIM token is not a console login)" {
        $r = Resolve-CtgSlackConsoleLogin -Secret ([pscustomobject]@{ Fields = @{ Username = "xoxp-not-an-email"; Password = "pw" } })
        $r.Ok | Should -BeFalse
        $r.Reason | Should -Match "must be an admin email"
        $r.Reason | Should -Not -Match "xoxp-not-an-email"
    }
    It "refuses when there is no password" {
        $r = Resolve-CtgSlackConsoleLogin -Secret ([pscustomobject]@{ Fields = @{ Username = "admin@acme.com" } })
        $r.Ok | Should -BeFalse
        $r.Reason | Should -Match "no Password"
    }
    It "refuses when nothing is wired" {
        (Resolve-CtgSlackConsoleLogin -Secret ([pscustomobject]@{ Fields = @{} })).Ok | Should -BeFalse
    }
}
