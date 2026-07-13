# The connect cache is keyed per systemKey, but several systemKeys drive ONE ambient connection:
# m365 / entra / m365-password-reset / tap / notify all Connect-CtgM365 (Connect-MgGraph holds a
# single process-wide context), and google-workspace / google-password-reset share a Google session.
#
# The bug this guards: an m365 job for client A connects Graph to A; an entra job for client B rebinds
# that same session to B; a second m365 job for A then finds its cache entry unchanged, SKIPS Connect,
# and runs against B's tenant — provisioning or offboarding A's user inside B's directory.
#
# Start-IamRunner.ps1 is not dot-sourceable (it's a script with a mandatory param block and a main
# loop), so — like the OnPremCapabilityProbe tests — we parse it as data and assert the invariants.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    # Pull the $script:ConnectionGroups map out of the runner and evaluate just that literal.
    $m = [regex]::Match($script:Runner, '(?ms)^\$script:ConnectionGroups\s*=\s*(@\{.*?^\})')
    $m.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare $script:ConnectionGroups'
    $script:Groups = & ([scriptblock]::Create($m.Groups[1].Value))
}

Describe 'shared-connection cache groups' {
    It 'declares the Graph group with every systemKey that rides the one Graph session' {
        # entra is an explicit alias of m365's handler; m365-password-reset and tap reuse
        # $DISPATCH['m365'].Connect by reference; notify calls Connect-CtgM365 with the same
        # m365-admin credential. All five therefore share one Connect-MgGraph context.
        foreach ($key in 'm365', 'entra', 'm365-password-reset', 'tap', 'notify') {
            $script:Groups.graph | Should -Contain $key
        }
    }

    It 'declares the Google group' {
        foreach ($key in 'google-workspace', 'google-password-reset') {
            $script:Groups.google | Should -Contain $key
        }
    }

    It 'puts every systemKey that reuses another handler''s Connect into a group' {
        # e.g. $DISPATCH['tap'] = @{ Connect = $DISPATCH['m365'].Connect ... } — a handler that borrows
        # another's Connect BY DEFINITION shares its ambient session, so it must be grouped with it.
        $borrowers = [regex]::Matches($script:Runner, "\`$DISPATCH\['([a-z0-9-]+)'\]\s*=\s*@\{[^}]*?Connect\s*=\s*\`$DISPATCH\['([a-z0-9-]+)'\]\.Connect")
        $borrowers.Count | Should -BeGreaterThan 0 -Because 'the borrow pattern is what makes this bug possible'
        $all = @($script:Groups.Values | ForEach-Object { $_ })
        foreach ($b in $borrowers) {
            $borrower = $b.Groups[1].Value
            $lender = $b.Groups[2].Value
            $all | Should -Contain $borrower -Because "$borrower reuses $lender's Connect, so it shares that session"
            $all | Should -Contain $lender   -Because "$lender's Connect is reused by $borrower"
            # ...and they must be in the SAME group, not merely both grouped.
            $g = $script:Groups.Keys | Where-Object { $script:Groups[$_] -contains $borrower }
            $script:Groups[$g] | Should -Contain $lender -Because "$borrower and $lender share ONE connection"
        }
    }

    It 'aliased handlers ($DISPATCH[x] = $DISPATCH[y]) are grouped together' {
        $aliases = [regex]::Matches($script:Runner, "\`$DISPATCH\['([a-z0-9-]+)'\]\s*=\s*\`$DISPATCH\['([a-z0-9-]+)'\]\s*$", 'Multiline')
        foreach ($a in $aliases) {
            $alias = $a.Groups[1].Value
            $target = $a.Groups[2].Value
            $g = $script:Groups.Keys | Where-Object { $script:Groups[$_] -contains $target }
            if ($g) {
                $script:Groups[$g] | Should -Contain $alias -Because "$alias is an alias of $target — same connection"
            }
        }
    }
}

Describe 'shared-connection cache invalidation' {
    It 'clears siblings after the cached Connect (the wrong-tenant path)' {
        # The set-then-clear pair must be present: caching this key without forgetting the siblings is
        # exactly the defect.
        $script:Runner | Should -Match '\$script:ConnectedTenant\[\$job\.systemKey\] = \$connectKey\s*\r?\n(?:\s*#.*\r?\n)*\s*Clear-CtgConnectionSiblings'
    }

    It 'clears the whole group when a conn-test or discovery connects outside the cached path' {
        # These bind the shared session without going through the cache, so no real job may reuse it.
        ([regex]::Matches($script:Runner, 'Clear-CtgConnectionSiblings\s+-SystemKey\s+\S+\s+-IncludeSelf')).Count |
            Should -BeGreaterOrEqual 2 -Because 'the conn-test and cloud-group discovery paths both connect out-of-band'
    }

    It 'no longer forgets a single key where a shared session was rebound' {
        # The old code did [void]$script:ConnectedTenant.Remove('m365') — dropping ONE key while the
        # Graph session it rebound was also cached under entra/tap/notify/m365-password-reset.
        $script:Runner | Should -Not -Match "ConnectedTenant\.Remove\('m365'\)"
    }

    It 'Start-IamRunner.ps1 still parses' {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path (Split-Path $PSScriptRoot -Parent) 'Start-IamRunner.ps1'), [ref]$null, [ref]$errs) | Out-Null
        $errs | Should -BeNullOrEmpty
    }
}
