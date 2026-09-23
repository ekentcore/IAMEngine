#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.DirectorySync. The ADSync cmdlets ship with Azure AD Connect
# (not a gallery module), so we stub + mock them. Behaviour: trigger a delta sync, but skip
# (idempotent) if a sync cycle is already running.

BeforeAll {
    function global:Get-ADSyncScheduler {}
    function global:Start-ADSyncSyncCycle { [CmdletBinding()] param([string]$PolicyType) }
    function global:Get-ADUser { param($Filter, $Properties, $Credential) }
    function global:Get-ADDomain { param($Credential) }
    Import-Module "$PSScriptRoot/../modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psm1" -Force
}

Describe 'Invoke-CtgDirectorySync' {
    # waitForSyncSeconds = 0 in the tests that are about start-vs-skip rather than waiting. Until the
    # closure bug was fixed these ran instantly BECAUSE the probe was broken: it threw, the wait gave up
    # at once, and nobody noticed the poll was never running. With the wait working, a test that leaves
    # it at the 120s default really does poll for 120s. Opting out explicitly keeps each test about one
    # thing — and the ones that ARE about waiting say so.
    BeforeEach { Mock Import-Module -ModuleName Coretelligent.DirectorySync -MockWith { } }  # local path loads ADSync in-proc
    It 'starts a delta sync when none is in progress' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 0 })
        $r.Status | Should -Be 'ok'
        Should -Invoke Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $PolicyType -eq 'Delta' }
        ($r.Actions -join ' ') | Should -Match 'started delta sync'
    }

    It 'skips (idempotent) when a sync cycle is already running' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $true } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 0 })
        Should -Invoke Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already in progress'
    }
}

Describe 'Invoke-CtgDirectorySync remoting (Model A)' {
    It 'remotes into the configured host when ADSync is not installed locally' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { 'started' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync'; waitForSyncSeconds = 0 }) -Credential $cred
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-Command -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $ComputerName -eq 'Core-CCE-AzSync' }
        ($r.Actions -join ' ') | Should -Match 'remoting into Entra Connect host'
    }

    It 'auto-discovers the Entra Connect host from the sync account when no host is configured' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Get-ADUser -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ Description = 'Account created by Microsoft Entra Connect ... running on computer CORE-CCE-AZSYNC configured to synchronize to tenant coretell.onmicrosoft.com.' } }
        Mock Get-ADDomain -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ DNSRoot = 'coretelligent.local' } }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { 'started' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 0 }) -Credential $cred
        Should -Invoke Invoke-Command -ModuleName Coretelligent.DirectorySync -Times 1 -Exactly -ParameterFilter { $ComputerName -eq 'CORE-CCE-AZSYNC.coretelligent.local' }
        ($r.Actions -join ' ') | Should -Match 'auto-discovered from AD'
    }

    It 'throws a clear error when ADSync is not local and the host cannot be determined' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Get-ADUser -ModuleName Coretelligent.DirectorySync -MockWith { @() }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) } | Should -Throw -ExpectedMessage '*host*'
    }

    It 'throws when remoting is needed but no credential was brokered' {
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) } | Should -Throw -ExpectedMessage '*credential*'
    }

    It 'surfaces a real remote failure — the pwsh7->5.1 fallback must not swallow a non-System.Web error' {
        # A genuine auth/connectivity error (not the .NET Core System.Web assembly gap) must propagate,
        # not be masked by the fallback. On the non-Windows test host the fallback is never attempted, so
        # the error surfaces directly — which is exactly the behaviour we want to lock.
        Mock Initialize-CtgADSync -ModuleName Coretelligent.DirectorySync -MockWith { $false }
        Mock Invoke-Command -ModuleName Coretelligent.DirectorySync -MockWith { throw 'Access is denied' }
        $cred = [pscredential]::new('CORP\svc', (ConvertTo-SecureString 'x' -AsPlainText -Force))
        { Invoke-CtgDirectorySync -Config ([pscustomobject]@{ host = 'Core-CCE-AzSync' }) -Credential $cred } | Should -Throw -ExpectedMessage '*Access is denied*'
    }
}

Describe 'Confirm-CtgDirectorySync' {
    BeforeEach { Mock Import-Module -ModuleName Coretelligent.DirectorySync -MockWith { } }  # local path loads ADSync in-proc
    It 'passes when the scheduler is enabled and a cycle is settled' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $true; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'still passes while a cycle is in progress (we just triggered it — not a miss)' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $true; SyncCycleInProgress = $true } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'fails when the sync scheduler is disabled' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $false; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}

# FR #0000112: the step used to return the instant the cycle was TRIGGERED, so the m365 step looked up
# an account Entra Connect had not written yet ("no synced M365 account for ..."). It now waits for the
# cycle to settle. Wait-CtgADSyncComplete is the pure unit — a caller-supplied probe stands in for the
# scheduler read, so the polling, the timeout and the start-race are all testable without ADSync.
Describe 'Wait-CtgADSyncComplete' {
    It 'returns completed as soon as the probe says no cycle is running' {
        $calls = [System.Collections.Generic.List[int]]::new()
        $r = Wait-CtgADSyncComplete -Probe { $calls.Add(1); $false } -TimeoutSeconds 5 -IntervalSeconds 0
        $r.Status | Should -Be 'completed'
        $calls.Count | Should -Be 1
    }

    It 'keeps polling until the cycle finishes' {
        $script:n = 0
        $r = Wait-CtgADSyncComplete -Probe { $script:n++; $script:n -lt 3 } -TimeoutSeconds 5 -IntervalSeconds 0
        $r.Status | Should -Be 'completed'
        $script:n | Should -Be 3   # running, running, then settled
    }

    It 'times out — and says so — when the cycle never settles' {
        # The onboard must not be held hostage by a sync that will not finish; it warns and moves on.
        $r = Wait-CtgADSyncComplete -Probe { $true } -TimeoutSeconds 1 -IntervalSeconds 0
        $r.Status | Should -Be 'timeout'
    }

    It 'SETTLES FIRST for a cycle we just started, before the first probe (the start race)' {
        # Start-ADSyncSyncCycle returns BEFORE the scheduler reports the cycle as running. Probing
        # immediately would see not-running and declare it complete — the exact bug being fixed,
        # reintroduced. So a cycle we started waits one interval before looking.
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Wait-CtgADSyncComplete -Probe { $false } -TimeoutSeconds 10 -IntervalSeconds 2 -SettleFirst
        $sw.Stop()
        $r.Status | Should -Be 'completed'
        $sw.Elapsed.TotalSeconds | Should -BeGreaterThan 1.5
    }

    It 'does NOT settle first for a cycle that was already running when we arrived' {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Wait-CtgADSyncComplete -Probe { $false } -TimeoutSeconds 10 -IntervalSeconds 2
        $sw.Stop()
        $r.Status | Should -Be 'completed'
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 1.5
    }

    It 'a probe that throws reports unknown instead of burning the whole budget' {
        # An unreadable scheduler is not a failed sync. Stop waiting, say so, let the onboard continue.
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Wait-CtgADSyncComplete -Probe { throw 'WinRM refused' } -TimeoutSeconds 30 -IntervalSeconds 5
        $sw.Stop()
        $r.Status | Should -Be 'unknown'
        $r.Error | Should -Match 'WinRM refused'
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 5
    }

    It 'never sleeps longer than the whole budget while settling' {
        # A 3s budget must not sit through a 10s settle interval.
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $null = Wait-CtgADSyncComplete -Probe { $false } -TimeoutSeconds 2 -IntervalSeconds 10 -SettleFirst
        $sw.Stop()
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 5
    }
}

# FR #0000127: "The system appears to be only showing success when the system itself is successful and
# doesn't throw any errors. I reran ... multiple times without success, but remoted into the server and
# ran the command, and then it finally synced."
#
# Half of that request — reporting a sync already in progress — shipped with FR #0000112. This is the
# other half, and it is not a message bug so much as a claim the step cannot support. A delta cycle
# completing is evidence that A cycle ran. It is NOT evidence that THIS user was exported: their OU may
# be out of sync scope, or a sync rule may filter them, and the cycle completes cleanly either way.
#
# directory-sync is in ALWAYS_ON_PREM_SYSTEMS and is brokered only ad-dc, so it has no Graph credential
# and genuinely cannot read Entra to check. What it must not do is imply it did. This is the same defect
# FR #0000093 found in ad-consistency-check, which reported "a fresh sync will anchor it (ok)" for a
# comparison it had never performed (see web/lib/jobs/cloud-object.ts).
Describe 'directory-sync claims only what it actually verified (FR #0000127)' {
    BeforeEach { Mock Import-Module -ModuleName Coretelligent.DirectorySync -MockWith { } }

    It 'does not tell the operator the account "should now be in Entra"' {
        # A finished cycle says nothing about any particular user. The old line read
        # "sync cycle finished after Ns — the account should now be in Entra".
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 1 })
        ($r.Actions -join ' ') | Should -Not -Match 'should now be in Entra'
    }

    It 'WARNs when it could not read the scheduler, instead of "probably fine"' {
        # This path had no WARN prefix, so run-report left the step green on a wait it never observed.
        # The FIRST scheduler read decides start-vs-skip and must succeed; only the probe reads that
        # follow it fail, which is the real shape of a host that becomes unreadable mid-wait.
        $script:schedCalls = 0
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith {
            $script:schedCalls++
            if ($script:schedCalls -gt 1) { throw 'scheduler unreadable' }
            [pscustomobject]@{ SyncCycleInProgress = $false }
        }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 1 })
        $joined = $r.Actions -join ' '
        $joined | Should -Not -Match 'probably fine'
        $joined | Should -Match 'WARN'
    }

    It 'does not promise that an already-running cycle will pick up the pending change' {
        # A cycle already running when we arrived may have taken its snapshot BEFORE the AD write, so
        # the change waits for the NEXT cycle. "will be picked up" is a guess stated as fact.
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $true } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 0 })
        ($r.Actions -join ' ') | Should -Not -Match 'will be picked up'
    }
}

Describe 'the directory-sync read-back names what it checked (FR #0000127)' {
    BeforeEach { Mock Import-Module -ModuleName Coretelligent.DirectorySync -MockWith { } }

    It 'says the scheduler check does NOT confirm the user reached Entra' {
        # The check passed on SyncCycleEnabled alone — a tenant-wide health flag — and the case then
        # showed directory-sync as verified, which operators read as "the user is in Entra".
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $true; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue    # it is still all this step CAN check — the pass is honest, the label was not
        ($r.checks.name -join ' | ') | Should -Match 'not confirm|does not verify|mechanism'
    }

    It 'still fails when the scheduler is disabled (unchanged)' {
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleEnabled = $false; SyncCycleInProgress = $false } }
        $r = Confirm-CtgDirectorySync -User ([pscustomobject]@{}) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}

# The bug the unit tests could not see. Wait-CtgADSyncComplete was tested as a pure unit with a
# caller-supplied probe (see FR #0000112's own note: "a caller-supplied probe stands in for the
# scheduler read"), so the seam was covered and the WIRING into it never was. Invoke-CtgDirectorySync
# built its probe with .GetNewClosure(), which re-hosts a scriptblock in a fresh dynamic module scope
# where this module's private helpers — Invoke-CtgAdSyncLocal / Invoke-CtgAdSyncRemote, neither
# exported — cannot be resolved. Every probe threw CommandNotFound, the wait reported 'unknown', and
# the step said "probably fine" and went green. So from runner 1.115.0 the wait never waited: it
# started the cycle, slept one settle interval, failed to probe, and claimed success.
#
# These tests drive the REAL Invoke-CtgDirectorySync and assert the probe actually reached the
# scheduler — the assertion the closure bug could not survive.
Describe 'the sync wait actually probes the scheduler (FR #0000127)' {
    BeforeEach { Mock Import-Module -ModuleName Coretelligent.DirectorySync -MockWith { } }

    It 'reaches the scheduler through the probe rather than failing to resolve its own helpers' {
        # Get-ADSyncScheduler is read once to decide start-vs-skip, then again by each probe. A probe
        # that cannot resolve Invoke-CtgAdSyncLocal never reaches the scheduler at all, so a count above
        # one is exactly what the closure bug made impossible.
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 1 })
        Should -Invoke Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -Times 2 -Exactly
        ($r.Actions -join ' ') | Should -Match 'sync cycle finished'
    }

    It 'never reports a CommandNotFound as an unreadable scheduler' {
        # The precise disguise: a wiring fault inside the runner was reported as a fact about the host.
        Mock Get-ADSyncScheduler -ModuleName Coretelligent.DirectorySync -MockWith { [pscustomobject]@{ SyncCycleInProgress = $false } }
        Mock Start-ADSyncSyncCycle -ModuleName Coretelligent.DirectorySync -MockWith { }
        $r = Invoke-CtgDirectorySync -Config ([pscustomobject]@{ waitForSyncSeconds = 1 })
        ($r.Actions -join ' ') | Should -Not -Match 'is not recognized as a name of a cmdlet'
    }

    It 'passes probe arguments instead of capturing them in a closure' {
        # Guards the fix itself: .GetNewClosure() here is what broke it, and it reads as harmless.
        $src = Get-Content "$PSScriptRoot/../modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psm1" -Raw
        # The CALL is what broke it; the comment explaining why it is gone must stay allowed.
        $src | Should -Not -Match '\}\.GetNewClosure\(\)'
        $src | Should -Match '-ProbeArgs'
    }
}
