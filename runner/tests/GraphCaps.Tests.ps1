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
    # Lift the two pure consumers.
    foreach ($name in 'Get-CtgGraphScopeGaps', 'Get-CtgGraphRightsRows') {
        $fn = [regex]::Match($src, "(?ms)^function $name\s*(\([^)]*\))?\s*\{.*?^\}")
        $fn.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare $name"
        . ([scriptblock]::Create($fn.Value))
    }
}

Describe 'GRAPH_OPTIONAL_CAPS' {
    It 'includes the offboard MFA-removal and multi-domain permissions' {
        $anyOf = $script:GRAPH_OPTIONAL_CAPS.anyOf
        $anyOf | Should -Contain 'UserAuthenticationMethod.ReadWrite.All'
        $anyOf | Should -Contain 'Domain.Read.All'
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
    }
}

Describe 'Get-CtgGraphRightsRows' {
    It 'flags optional rows with optional=$true and marks a missing one ok=$false' {
        $granted = @('User.ReadWrite.All', 'Group.ReadWrite.All', 'Organization.Read.All')
        $rows = Get-CtgGraphRightsRows $granted
        $opt = @($rows | Where-Object { $_.optional })
        $opt.Count | Should -Be 2
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
