# The self-heal installs a missing module and used to Import-Module it into the LIVE runner process.
#
# ExchangeOnlineManagement and Microsoft.Graph both carry Azure.Core and Microsoft.Identity.Client.
# Importing the second into a process that already bound the first loads a SECOND, incompatible copy,
# and from then on Graph calls never return — no error, no timeout, just a process holding a job.
#
# 2026-09-02/03, central runner: EXO went missing on CORE-CCE-DC01, the self-heal installed AND
# imported it mid-run, the next Get-MgUser hung forever, the 600s stall watchdog respawned the
# process, the app re-dispatched the job, and it wedged again — a loop that reads as "the runner
# keeps crashing".
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# ConnectionCache tests — we extract the function and evaluate just that.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $g = [regex]::Match($script:Runner, '(?ms)^\$script:CtgAssemblySharingGroups\s*=\s*(@\{.*?^\})')
    $g.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare $script:CtgAssemblySharingGroups'
    $script:CtgAssemblySharingGroups = & ([scriptblock]::Create($g.Groups[1].Value))

    $f = [regex]::Match($script:Runner, '(?ms)^function Test-CtgModuleConflictsWithLoaded \{.*?^\}')
    $f.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Test-CtgModuleConflictsWithLoaded'
    . ([scriptblock]::Create($f.Value))

    foreach ($fn in 'Test-CtgSelfHealRestartAllowed', 'Set-CtgSelfHealRestart') {
        $g = [regex]::Match($script:Runner, "(?ms)^function $([regex]::Escape($fn)) \{.*?^\}")
        $g.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare $fn"
        . ([scriptblock]::Create($g.Value))
    }
}

Describe 'Test-CtgModuleConflictsWithLoaded' {
    It 'REFUSES ExchangeOnlineManagement when Microsoft.Graph is already loaded (the wedge)' {
        $loaded = @(@{ Name = 'Microsoft.Graph.Authentication' }, @{ Name = 'Coretelligent.M365' })
        Test-CtgModuleConflictsWithLoaded -Name 'ExchangeOnlineManagement' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeTrue
    }

    It 'ALLOWS ExchangeOnlineManagement when no Graph module is loaded' {
        # An AD-only client agent has no Graph session; importing EXO there is safe and must stay so.
        $loaded = @(@{ Name = 'Coretelligent.ActiveDirectory' }, @{ Name = 'ActiveDirectory' })
        Test-CtgModuleConflictsWithLoaded -Name 'ExchangeOnlineManagement' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeFalse
    }

    It 'ALLOWS a Microsoft.Graph submodule joining its own siblings' {
        # Graph submodules share one version line (the skew guard keeps them aligned), so pulling in a
        # missing sibling is the normal, safe case the self-heal was built for. Blocking it would turn
        # every missing submodule into a restart.
        $loaded = @(@{ Name = 'Microsoft.Graph.Authentication' }, @{ Name = 'Microsoft.Graph.Users' })
        Test-CtgModuleConflictsWithLoaded -Name 'Microsoft.Graph.Groups' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeFalse
    }

    It 'REFUSES Graph when ExchangeOnlineManagement is already loaded (the mirror case)' {
        $loaded = @(@{ Name = 'ExchangeOnlineManagement' })
        Test-CtgModuleConflictsWithLoaded -Name 'Microsoft.Graph.Users' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeTrue
    }

    It 'ALLOWS a module in no sharing group at all (ActiveDirectory, ADSync)' {
        $loaded = @(@{ Name = 'Microsoft.Graph.Authentication' })
        Test-CtgModuleConflictsWithLoaded -Name 'ActiveDirectory' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeFalse
        Test-CtgModuleConflictsWithLoaded -Name 'ADSync' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeFalse
    }

    It 'ALLOWS anything when nothing is loaded' {
        $loaded = @()
        Test-CtgModuleConflictsWithLoaded -Name 'ExchangeOnlineManagement' -Loaded @($loaded | ForEach-Object { $_.Name }) -Groups $script:CtgAssemblySharingGroups | Should -BeFalse
    }
}

Describe 'the self-heal never imports into a live process without checking' {
    It 'guards its Import-Module with the conflict test' {
        # The whole fix is that this one Import-Module cannot be reached for a conflicting module.
        # A future edit that moves or duplicates it must fail here rather than in production.
        $repair = [regex]::Match($script:Runner, '(?ms)^function Repair-CtgMissingModule \{.*?^\}').Value
        $repair | Should -Match 'Test-CtgModuleConflictsWithLoaded'
        # The conflict branch must return BEFORE the import.
        $guardAt  = $repair.IndexOf('Test-CtgModuleConflictsWithLoaded')
        $importAt = $repair.IndexOf('Import-Module $mod -Force')
        $importAt | Should -BeGreaterThan $guardAt
    }

    It 'asks for a restart rather than silently skipping the module' {
        # Installing and then neither importing nor restarting would leave the step failing forever
        # with no path forward — the silent-failure class this codebase keeps finding.
        $repair = [regex]::Match($script:Runner, '(?ms)^function Repair-CtgMissingModule \{.*?^\}').Value
        $repair | Should -Match 'CtgRestartReason'
        $script:Runner | Should -Match 'if \(\$script:CtgRestartReason\) \{[\s\S]*?Restart-CtgRunner'
    }
}

# A supervised runner's Invoke-CtgRelaunch just `exit 0`s and trusts the service manager. If that
# relaunch does not happen — a supervisor set to restart only on FAILURE reads exit 0 as a clean
# shutdown — the runner stays DOWN until a human starts it. So an automatic restart that keeps being
# requested does not loop noisily; it takes the fleet offline, once, and quietly. That is what the
# self-heal restart did on 2026-09-08/09: the same missing module was repaired every poll cycle, each
# time asking for a restart.
Describe 'the self-heal restart cannot loop' {
    BeforeEach { $script:MarkerPath = Join-Path $TestDrive "selfheal-$([guid]::NewGuid()).json" }

    It 'allows the FIRST restart for a reason' {
        Test-CtgSelfHealRestartAllowed -Reason 'installed EXO' -Path $script:MarkerPath | Should -BeTrue
    }

    It 'REFUSES a second restart for the same reason inside the window' {
        $now = Get-Date
        Set-CtgSelfHealRestart -Reason 'installed EXO' -Path $script:MarkerPath -Now $now
        Test-CtgSelfHealRestartAllowed -Reason 'installed EXO' -Path $script:MarkerPath -Now $now.AddMinutes(5) -WindowMinutes 60 | Should -BeFalse
    }

    It 'allows it again once the window has passed' {
        $now = Get-Date
        Set-CtgSelfHealRestart -Reason 'installed EXO' -Path $script:MarkerPath -Now $now
        Test-CtgSelfHealRestartAllowed -Reason 'installed EXO' -Path $script:MarkerPath -Now $now.AddMinutes(90) -WindowMinutes 60 | Should -BeTrue
    }

    It 'allows a restart for a DIFFERENT module — that repair has not been tried' {
        $now = Get-Date
        Set-CtgSelfHealRestart -Reason 'installed EXO' -Path $script:MarkerPath -Now $now
        Test-CtgSelfHealRestartAllowed -Reason 'installed ADSync' -Path $script:MarkerPath -Now $now.AddMinutes(1) | Should -BeTrue
    }

    It 'allows the restart when the marker is unreadable rather than blocking forever' {
        Set-Content -Path $script:MarkerPath -Value 'not json' -Encoding utf8
        Test-CtgSelfHealRestartAllowed -Reason 'installed EXO' -Path $script:MarkerPath | Should -BeTrue
    }

    It 'the poll loop consults the guard before restarting' {
        # A future edit that calls Restart-CtgRunner directly from the self-heal path would reopen the
        # outage. The guard call must sit between the reason and the restart.
        $guardAt = $script:Runner.IndexOf('Test-CtgSelfHealRestartAllowed -Reason $reason')
        $restartAt = $script:Runner.IndexOf('Restart-CtgRunner   # re-execs')
        $guardAt | Should -BeGreaterThan -1
        $restartAt | Should -BeGreaterThan $guardAt
    }
}
