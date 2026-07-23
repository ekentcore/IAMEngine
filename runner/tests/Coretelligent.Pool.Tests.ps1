#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Pool — the runner-pool crux: member-identity resolution (distinct
# agentIds = the no-double-execution boundary), agentId-scoped lock naming (members coexist), and the
# roster round-trip (stable ids across restarts). Pure/file helpers only — no processes spawned.

BeforeAll {
    Import-Module "$PSScriptRoot/../lib/Coretelligent.Pool/Coretelligent.Pool.psm1" -Force
    Import-Module "$PSScriptRoot/../lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1" -Force
}

Describe 'Get-CtgPoolLockPath' {
    It 'keys the lock file by agentId (matches Start-IamRunner .runner.<agentId>.lock)' {
        Get-CtgPoolLockPath -RunnerDir '/opt/iam-runner' -AgentId 'cmqABC' |
            Should -Be (Join-Path '/opt/iam-runner' '.runner.cmqABC.lock')
    }
    It 'gives two distinct members two distinct lock paths (so they coexist, not evict)' {
        $a = Get-CtgPoolLockPath -RunnerDir '/d' -AgentId 'id0'
        $b = Get-CtgPoolLockPath -RunnerDir '/d' -AgentId 'id1'
        $a | Should -Not -Be $b
    }
    It 'gives the same member the same path (newest-PID-wins eviction still fires within one id)' {
        (Get-CtgPoolLockPath -RunnerDir '/d' -AgentId 'id0') | Should -Be (Get-CtgPoolLockPath -RunnerDir '/d' -AgentId 'id0')
    }
    It 'matches the .runner.*.lock glob the self-update prune skip-list uses' {
        # Regression: broadening the prune skip-list from ".runner.lock" to ".runner*.lock" must cover
        # the per-agent lock so a Windows self-update never deletes a live member lock.
        $name = Split-Path (Get-CtgPoolLockPath -RunnerDir '/d' -AgentId 'id0') -Leaf
        $name -like '.runner*.lock' | Should -BeTrue
    }
}

Describe 'Get-CtgPoolMemberName' {
    It 'labels a member <host> pool #<index>' {
        Get-CtgPoolMemberName -HostName 'cloud-01' -Index 2 | Should -Be 'cloud-01 pool #2'
    }
}

Describe 'Resolve-CtgPoolMembers' {
    It 'N=1 returns just the anchor, never enrolling (single-runner backward compat)' {
        $m = @(Resolve-CtgPoolMembers -PoolSize 1 -AnchorAgentId 'anchor' -Roster @())
        $m.Count | Should -Be 1
        $m[0].index | Should -Be 0
        $m[0].agentId | Should -Be 'anchor'
        $m[0].needsEnroll | Should -BeFalse
    }

    It 'N=3 with 1 pre-enrolled reuses it and marks the other new one to enroll' {
        $roster = @(@{ index = 1; agentId = 'member1' })
        $m = @(Resolve-CtgPoolMembers -PoolSize 3 -AnchorAgentId 'anchor' -Roster $roster)
        $m.Count | Should -Be 3
        $m[0].agentId | Should -Be 'anchor';   $m[0].needsEnroll | Should -BeFalse
        $m[1].agentId | Should -Be 'member1';  $m[1].needsEnroll | Should -BeFalse   # reused, not re-enrolled
        $m[2].agentId | Should -BeNullOrEmpty;  $m[2].needsEnroll | Should -BeTrue    # index 2 must enroll
    }

    It 'the anchor always wins index 0 over a stale roster entry there' {
        $roster = @(@{ index = 0; agentId = 'STALE' }, @{ index = 1; agentId = 'member1' })
        $m = @(Resolve-CtgPoolMembers -PoolSize 2 -AnchorAgentId 'anchor' -Roster $roster)
        $m[0].agentId | Should -Be 'anchor'
    }

    It 'N reduced below the roster size drops extras and does NOT re-enroll the survivors' {
        $roster = @(@{ index = 1; agentId = 'm1' }, @{ index = 2; agentId = 'm2' }, @{ index = 3; agentId = 'm3' })
        $m = @(Resolve-CtgPoolMembers -PoolSize 2 -AnchorAgentId 'anchor' -Roster $roster)
        $m.Count | Should -Be 2
        $m[1].agentId | Should -Be 'm1'
        $m[1].needsEnroll | Should -BeFalse
        # index 2 and 3 are simply absent from the returned set (dropped, not touched).
        ($m | Where-Object { $_.index -ge 2 }).Count | Should -Be 0
    }

    It 'every member has a DISTINCT id (the no-double-execution correctness boundary)' {
        $roster = @(@{ index = 1; agentId = 'm1' }, @{ index = 2; agentId = 'm2' })
        $m = @(Resolve-CtgPoolMembers -PoolSize 3 -AnchorAgentId 'anchor' -Roster $roster)
        $ids = @($m | ForEach-Object { $_.agentId })
        ($ids | Sort-Object -Unique).Count | Should -Be $ids.Count   # no duplicates
    }
}

Describe 'supervisor per-member keep-alive decision (reuses Get-CtgKeepAliveAction)' {
    # The pool supervisor calls Get-CtgKeepAliveAction per member; assert a mixed table maps to the
    # right action so a dead OR wedged member is peer-restarted while a healthy one is left alone.
    It 'restarts gone/wedged members, leaves healthy ones' {
        $members = @(
            @{ alive = $true;  health = @{ healthy = $true }                 ; expect = 'ok' }       # #0 healthy
            @{ alive = $false; health = @{ healthy = $true }                 ; expect = 'restart' }  # #1 process gone
            @{ alive = $true;  health = @{ healthy = $false; reason = 'no progress for 900s' }; expect = 'restart' }  # #2 wedged
            @{ alive = $true;  health = @{ healthy = $true; reason = 'no heartbeat file yet' }; expect = 'ok' }       # #3 starting (fail-safe)
        )
        foreach ($m in $members) {
            (Get-CtgKeepAliveAction -ProcessAlive $m.alive -Health $m.health).action | Should -Be $m.expect
        }
    }
}

Describe 'roster round-trip (Read/Write-CtgPoolRoster)' {
    BeforeEach { $script:rp = Join-Path ([System.IO.Path]::GetTempPath()) "pool-roster-$([guid]::NewGuid()).json" }
    AfterEach  { if (Test-Path -LiteralPath $script:rp) { Remove-Item -LiteralPath $script:rp -Force } }

    It 'reads an empty array when the file is missing (fail-safe)' {
        (Read-CtgPoolRoster -Path $script:rp) | Should -BeNullOrEmpty
    }

    It 'persists only members that HAVE an id and reads them back' {
        $members = @(
            @{ index = 0; agentId = 'anchor' },
            @{ index = 1; agentId = 'm1' },
            @{ index = 2; agentId = $null }        # not enrolled yet -> omitted
        )
        Write-CtgPoolRoster -Path $script:rp -Members $members | Should -BeTrue
        $back = @(Read-CtgPoolRoster -Path $script:rp)
        $back.Count | Should -Be 2
        ($back | Where-Object { $_.index -eq 1 }).agentId | Should -Be 'm1'
        ($back | Where-Object { $_.index -eq 2 }).Count | Should -Be 0
    }

    It 'a single-member roster still round-trips as an array (not a bare object)' {
        Write-CtgPoolRoster -Path $script:rp -Members @(@{ index = 0; agentId = 'only' }) | Should -BeTrue
        $back = @(Read-CtgPoolRoster -Path $script:rp)
        $back.Count | Should -Be 1
        $back[0].agentId | Should -Be 'only'
    }

    It 'a corrupt roster file reads as empty rather than throwing' {
        [System.IO.File]::WriteAllText($script:rp, 'not json {{{')
        (Read-CtgPoolRoster -Path $script:rp) | Should -BeNullOrEmpty
    }

    It 'resolve -> persist -> resolve is stable (ids reused, nothing re-enrolled)' {
        # Simulate first boot: enroll index 1+2, persist, then a restart reuses them with no needsEnroll.
        $first = @(Resolve-CtgPoolMembers -PoolSize 3 -AnchorAgentId 'anchor' -Roster @())
        $first[1].agentId = 'enrolled1'; $first[1].needsEnroll = $false
        $first[2].agentId = 'enrolled2'; $first[2].needsEnroll = $false
        Write-CtgPoolRoster -Path $script:rp -Members $first | Out-Null

        $roster = @(Read-CtgPoolRoster -Path $script:rp)
        $second = @(Resolve-CtgPoolMembers -PoolSize 3 -AnchorAgentId 'anchor' -Roster $roster)
        ($second | Where-Object { $_.needsEnroll }).Count | Should -Be 0
        $second[1].agentId | Should -Be 'enrolled1'
        $second[2].agentId | Should -Be 'enrolled2'
    }
}
