# Graph required/optional capability probe: the rows the m365/entra conn-test reports, and the
# invariant that an OPTIONAL permission (UserAuthenticationMethod.ReadWrite.All for offboard MFA
# removal; Domain.Read.All for multi-domain clients) is surfaced but NEVER counted as a gap — a gap
# is what fails the test. Regression guard for the core1994 fix.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# AdConnection / AdobeSecret suites — we parse it as text and lift the pieces we need.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $src = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    # Lift the two capability tables ($script:GRAPH_*_CAPS = @( ... )), matched to their closing ^).
    foreach ($var in 'GRAPH_REQUIRED_CAPS', 'GRAPH_OPTIONAL_CAPS') {
        $m = [regex]::Match($src, "(?ms)^\`$script:$var = @\(.*?^\)")
        $m.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare `$script:$var"
        . ([scriptblock]::Create($m.Value))
    }
    # Lift the escalation map + the non-Graph allow-list the surplus check reads.
    foreach ($var in 'GRAPH_ESCALATION_ROLES') {
        $m = [regex]::Match($src, "(?ms)^\`$script:$var = @\{.*?^\}")
        $m.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare `$script:$var"
        . ([scriptblock]::Create($m.Value))
    }
    $m = [regex]::Match($src, "(?m)^\`$script:USED_NON_GRAPH_ROLES = .*$")
    $m.Success | Should -BeTrue
    . ([scriptblock]::Create($m.Value))
    # Lift the pure consumers.
    foreach ($name in 'Get-CtgGraphScopeGaps', 'Get-CtgGraphRightsRows', 'Get-CtgGraphSurplusRoles') {
        $fn = [regex]::Match($src, "(?ms)^function $name\s*(\([^)]*\))?\s*\{.*?^\}")
        $fn.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare $name"
        . ([scriptblock]::Create($fn.Value))
    }
}

# The conn test only ever asked "can it do the job?". This is the other half — what authority did we
# get handed that we never asked for? Across the fleet: 4 credentials can make themselves Global
# Administrator, and 5 can add credentials to any app registration in their tenant.
Describe 'Get-CtgGraphSurplusRoles (over-permissioning)' {
    # $script:, and set in BeforeAll: a plain $narrow in the Describe body is NOT visible inside It in
    # Pester 5 — it arrives as $null, and "no surplus" tests then pass vacuously on an empty grant,
    # which is the failure mode this whole PR is about (a check that is green because it looked at
    # nothing). The assertion below fails loudly instead.
    BeforeAll { $script:narrow = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All') }

    It 'has its fixture (guards against Pester scoping silently emptying it)' {
        @($script:narrow).Count | Should -Be 3
    }

    It 'reports nothing for a least-privilege credential' {
        @(Get-CtgGraphSurplusRoles ($script:narrow + 'Exchange.ManageAsApp')) | Should -BeNullOrEmpty
    }

    It 'flags an escalation role and says what it actually permits' {
        $s = @(Get-CtgGraphSurplusRoles ($script:narrow + 'RoleManagement.ReadWrite.Directory'))
        $s.Count | Should -Be 1
        $s[0].role | Should -Be 'RoleManagement.ReadWrite.Directory'
        $s[0].escalation | Should -BeTrue
        # Naming the role means nothing to most readers; naming what it permits ends the conversation.
        $s[0].why | Should -BeLike '*Global Administrator*'
    }

    It 'flags the BROAD role as redundant, never the narrow one the engine runs on' {
        $s = @(Get-CtgGraphSurplusRoles ($script:narrow + 'GroupMember.ReadWrite.All'))
        $s.role | Should -Be 'GroupMember.ReadWrite.All'
        $s[0].why | Should -BeLike '*redundant — Group.ReadWrite.All is also granted*'
    }

    It 'does NOT flag a broad role that is still the only thing covering a capability' {
        # Directory.ReadWrite.All alone covers the domain, expiry and device caps here — calling it
        # surplus would be advice that breaks three features.
        @(Get-CtgGraphSurplusRoles ($script:narrow + 'Directory.ReadWrite.All')) | Should -BeNullOrEmpty
    }

    It 'does not call Exchange.ManageAsApp unused — it is used, just not a Graph role' {
        @(Get-CtgGraphSurplusRoles ($script:narrow + 'Exchange.ManageAsApp')) | Should -BeNullOrEmpty
    }

    It 'surfaces surplus as rows that can NEVER fail the test' {
        $rows = @(Get-CtgGraphRightsRows ($script:narrow + 'RoleManagement.ReadWrite.Directory'))
        $sur = @($rows | Where-Object { $_.surplus })
        $sur.Count | Should -Be 1
        $sur[0].optional | Should -BeTrue  # optional => summarizeRights ignores it for pass/fail
        $sur[0].op | Should -BeLike 'OVER-PERMISSIONED*'
        # ...and the thing that DOES drive pass/fail never mentions it.
        @(Get-CtgGraphScopeGaps ($script:narrow + 'RoleManagement.ReadWrite.Directory')).Count | Should -Be 0
    }
}

Describe 'GRAPH_OPTIONAL_CAPS' {
    It 'includes the offboard MFA-removal and multi-domain permissions' {
        $anyOf = $script:GRAPH_OPTIONAL_CAPS.anyOf
        $anyOf | Should -Contain 'UserAuthenticationMethod.ReadWrite.All'
        $anyOf | Should -Contain 'Domain.Read.All'
    }
    # Graph gates passwordProfile behind its own app role: User.ReadWrite.All sets a password at CREATE
    # time but cannot CHANGE one. Nothing asked for this role before 1.68.0, so every reset in the fleet
    # failed with a bare "Insufficient privileges" while the conn test stayed green.
    It 'includes the password-reset permission (UM0028954)' {
        $script:GRAPH_OPTIONAL_CAPS.anyOf | Should -Contain 'User-PasswordProfile.ReadWrite.All'
    }
    # Same shape of miss as the reset, found by auditing every Graph call the runner makes against this
    # table: a feature shipped, nobody added its permission, and no tenant in the fleet had it.
    It 'includes the notification-mail permission (Send-MgUserMail)' {
        $script:GRAPH_OPTIONAL_CAPS.anyOf | Should -Contain 'Mail.Send'
    }
    It 'includes the device-disable permission (Update-MgDevice)' {
        $script:GRAPH_OPTIONAL_CAPS.anyOf | Should -Contain 'Device.ReadWrite.All'
    }
    # Directory.Read.All is a HIGHER-privileged alternative for GET /domains, so a tenant holding it must
    # not be told to grant Domain.Read.All (verified live: core1390 reads /domains 200 without it).
    It 'accepts a broader role for the domain read instead of demanding Domain.Read.All' {
        $granted = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All', 'Directory.Read.All')
        $rows = Get-CtgGraphRightsRows $granted
        $dom = @($rows | Where-Object { $_.op -like '*verified email domains*' })[0]
        $dom.ok | Should -BeTrue -Because 'Directory.Read.All already covers reading /domains'
    }
    # Every cap must correspond to a call the runner actually makes. Revoking sign-in sessions is the
    # counter-example that keeps this honest: Microsoft documents User.RevokeSessions.All as the only
    # app-only permission for it, but 12 production offboards revoked sessions on User.ReadWrite.All
    # with zero warnings — so modelling it would invent a gap that does not exist.
    It 'does NOT model session revoke — it works on User.ReadWrite.All despite the docs' {
        ($script:GRAPH_OPTIONAL_CAPS.anyOf -join ' ') | Should -Not -BeLike '*RevokeSessions*'
        ($script:GRAPH_REQUIRED_CAPS.anyOf -join ' ') | Should -Not -BeLike '*RevokeSessions*'
    }
}

# The stale-token self-heal (a RequestDenied often means a token minted BEFORE consent) was gated on a
# hardcoded @('m365','entra') while $ConnectionGroups.graph lists five keys that share the one Graph
# session. So m365-password-reset never healed — and that is precisely the step whose fix is "grant the
# permission": the admin grants it, the operator retries, and the pre-consent token denies it again.
# Text-matched because the gate lives in the job loop, which the suite cannot dot-source.
Describe 'stale Graph token self-heal' {
    BeforeAll { $script:src = Get-Content "$(Split-Path $PSScriptRoot -Parent)/Start-IamRunner.ps1" -Raw }

    It 'gates on the Graph connection group, not a hardcoded m365/entra pair' {
        # Scoped to the self-heal block on purpose. The OTHER m365/entra gate further down (the
        # "which permission is missing" enrichment) stays a hardcoded pair deliberately: its hint is a
        # phase heuristic that only knows the three required roles, so firing it on a password-reset
        # denial would staple "grant User.ReadWrite.All" onto the module's accurate
        # User-PasswordProfile.ReadWrite.All message. Two gates, two different right answers.
        $heal = [regex]::Match($script:src, '(?ms)Self-heal a STALE app-only Graph token.*?Set-CtgPhase \$job\.id "RequestDenied')
        $heal.Success | Should -BeTrue -Because 'the self-heal block must still exist'
        $heal.Value | Should -Match '\$script:ConnectionGroups\.graph -contains \$job\.systemKey'
        $heal.Value | Should -Not -Match "\`$job\.systemKey -in @\('m365', 'entra'\)"
    }

    It 'covers every systemKey that shares the one Graph session' {
        $m = [regex]::Match($script:src, "(?ms)^\`$script:ConnectionGroups = @\{.*?^\}")
        $m.Success | Should -BeTrue
        . ([scriptblock]::Create($m.Value))
        # If a new Graph-backed lane is added to the group it inherits the self-heal for free — that is
        # the point of gating on the group.
        $script:ConnectionGroups.graph | Should -Contain 'm365-password-reset'
        $script:ConnectionGroups.graph | Should -Contain 'tap'
        $script:ConnectionGroups.graph | Should -Contain 'notify'
    }
}

Describe 'Get-CtgGraphScopeGaps (drives the pass/fail)' {
    It 'reports NO gap when every REQUIRED permission is present, even with all optionals missing' {
        # exactly the required scopes, none of the optional ones
        $granted = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All')
        $gaps = Get-CtgGraphScopeGaps $granted
        @($gaps).Count | Should -Be 0
    }
    It 'reports a gap for a genuinely missing REQUIRED permission' {
        $granted = @('Group.ReadWrite.All', 'Organization.Read.All') # no user create
        $gaps = Get-CtgGraphScopeGaps $granted
        @($gaps).Count | Should -Be 1
        ($gaps -join ' ') | Should -BeLike '*create*'
    }
    It 'never names an optional permission as a gap' {
        $gaps = Get-CtgGraphScopeGaps @()
        ($gaps -join ' ') | Should -Not -BeLike '*UserAuthenticationMethod*'
        ($gaps -join ' ') | Should -Not -BeLike '*Domain.Read.All*'
        # Optional even though the reset HARD-fails without it: a client who never resets a cloud
        # password is unaffected, and 0/31 wired tenants have it today — making it required would fail
        # every conn test in the fleet for a step most cases never run.
        ($gaps -join ' ') | Should -Not -BeLike '*PasswordProfile*'
    }
}

Describe 'Get-CtgGraphRightsRows' {
    It 'flags optional rows with optional=$true and marks a missing one ok=$false' {
        $granted = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All')
        $rows = Get-CtgGraphRightsRows $granted
        $opt = @($rows | Where-Object { $_.optional })
        $opt.Count | Should -Be @($script:GRAPH_OPTIONAL_CAPS).Count
        ($opt | ForEach-Object { $_.ok }) | Should -Not -Contain $true  # none granted here
        # required all present
        @($rows | Where-Object { -not $_.optional -and $_.ok -ne $true }).Count | Should -Be 0
    }
    It 'marks the optional row ok=$true once its permission is granted' {
        $granted = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All', 'UserAuthenticationMethod.ReadWrite.All')
        $rows = Get-CtgGraphRightsRows $granted
        $mfa = @($rows | Where-Object { $_.optional -and $_.op -like '*MFA*' })[0]
        $mfa.ok | Should -BeTrue
    }
}
