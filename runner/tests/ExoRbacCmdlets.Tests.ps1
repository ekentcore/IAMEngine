# FR #0000125: Brighton Park's offboard failed on "'Get-MailboxStatistics' is not recognized" right
# after a successful app-only Connect-ExchangeOnline, and the runner then tried to INSTALL a module.
#
# A cmdlet can be missing from a CONNECTED session: the app's RBAC role may not grant it (EXO builds the
# session from it), or the session didn't load fully in that runner process (Brighton Park had the role).
# Either way it is not a missing module -- the connect just used it. Two consequences, both tested here:
#   - the connection test must check the cmdlets the lanes call, not treat "connected" as proof of
#     the Exchange Administrator role (it claimed exactly that);
#   - the missing-command handler must name both causes, not attempt an install that cannot help.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    Import-Module "$Root/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw
    $script:Module = Get-Content "$Root/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Raw
}

AfterAll {
    Remove-Module Coretelligent.Exchange -Force -ErrorAction SilentlyContinue
}

Describe 'Test-CtgExoCmdlet' {
    It 'knows the cmdlet that failed on Brighton Park' {
        Test-CtgExoCmdlet 'Get-MailboxStatistics' | Should -BeTrue
    }
    It 'does not claim our own functions or unrelated cmdlets' {
        Test-CtgExoCmdlet 'Get-CtgMailboxSizeGB' | Should -BeFalse
        Test-CtgExoCmdlet 'Get-MgUser' | Should -BeFalse
        Test-CtgExoCmdlet '' | Should -BeFalse
    }
    It 'does not list the on-prem RemoteMailbox cmdlets (they come from a different session)' {
        Test-CtgExoCmdlet 'Enable-RemoteMailbox' | Should -BeFalse
    }
}

Describe 'Get-CtgExoMissingCmdlet' {
    It 'reports exactly the cmdlets absent from the session' {
        function global:Get-FakeExoPresent { }
        try {
            $missing = Get-CtgExoMissingCmdlet -Name @('Get-FakeExoPresent', 'Get-FakeExoAbsentXyz')
            $missing | Should -Be @('Get-FakeExoAbsentXyz')
        }
        finally { Remove-Item function:global:Get-FakeExoPresent -ErrorAction SilentlyContinue }
    }
    It 'is empty when everything is present' {
        @(Get-CtgExoMissingCmdlet -Name @('Get-Command')).Count | Should -Be 0
    }
    It 'covers every EXO cmdlet the module calls, so the connection test cannot miss one' {
        $exo = 'Mailbox\w*|Recipient\w*|DistributionGroup\w*|UnifiedGroup\w*|CASMailbox'
        $called = [regex]::Matches($script:Module, "\b(?:Get|Set|Add|Remove|New|Enable|Disable)-(?:$exo)\b") |
            ForEach-Object Value | Where-Object { $_ -notmatch 'RemoteMailbox' } | Sort-Object -Unique
        foreach ($c in $called) { Test-CtgExoCmdlet $c | Should -BeTrue -Because "$c is called by the Exchange lanes" }
    }
}

Describe 'the runner' {
    It 'checks for an EXO role gap before trying to install a module' {
        $gap = $script:Runner.IndexOf('is not available in this Exchange Online session')
        $install = $script:Runner.IndexOf("locating + installing its module")
        $gap | Should -BeGreaterThan 0
        $gap | Should -BeLessThan $install
    }
    It 'names BOTH causes -- the role, and a session that did not load (restart the runner)' {
        $m = [regex]::Match($script:Runner, 'is not available in this Exchange Online session[^"]*').Value
        $m | Should -Match 'Exchange Administrator'
        $m | Should -Match 'restart the runner'
    }
    It 'no longer claims a connect proves the Exchange Administrator role' {
        $script:Runner | Should -Not -Match 'PROVES the app holds Exchange\.ManageAsApp \+ the\s+# Exchange Administrator role'
        $script:Runner | Should -Match 'Get-CtgExoMissingCmdlet'
    }
}
