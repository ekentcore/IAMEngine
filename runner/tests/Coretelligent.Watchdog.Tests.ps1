#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Watchdog — the stall decision, the fail-safe health probe, the
# heartbeat-path resolution, and that a heartbeat write actually refreshes freshness.

BeforeAll {
    Import-Module "$PSScriptRoot/../lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1" -Force
    $script:Now = Get-Date
}

Describe 'Test-CtgStalled' {
    It 'is NOT stalled when activity is within the timeout' {
        Test-CtgStalled -LastActivity $script:Now.AddSeconds(-30) -Now $script:Now -TimeoutSeconds 600 | Should -BeFalse
    }
    It 'IS stalled when activity is older than the timeout' {
        Test-CtgStalled -LastActivity $script:Now.AddSeconds(-601) -Now $script:Now -TimeoutSeconds 600 | Should -BeTrue
    }
    It 'is NOT stalled exactly at the boundary (strictly greater-than)' {
        Test-CtgStalled -LastActivity $script:Now.AddSeconds(-600) -Now $script:Now -TimeoutSeconds 600 | Should -BeFalse
    }
}

Describe 'Test-CtgRunnerHealth' {
    BeforeEach {
        $script:hb = Join-Path ([System.IO.Path]::GetTempPath()) "wd-test-$([guid]::NewGuid()).heartbeat"
    }
    AfterEach {
        if (Test-Path -LiteralPath $script:hb) { Remove-Item -LiteralPath $script:hb -Force }
    }

    It 'reports healthy (fail-safe) when the heartbeat file does not exist yet' {
        $h = Test-CtgRunnerHealth -Path $script:hb -TimeoutSeconds 600
        $h.healthy | Should -BeTrue
        $h.reason  | Should -Match 'starting'
    }

    It 'reports healthy when the heartbeat is fresh' {
        Update-CtgHeartbeat -Path $script:hb -Phase 'onboard m365'
        (Test-CtgRunnerHealth -Path $script:hb -TimeoutSeconds 600).healthy | Should -BeTrue
    }

    It 'reports UNHEALTHY when the heartbeat is older than the timeout' {
        Update-CtgHeartbeat -Path $script:hb -Phase 'wedged'
        # Evaluate "now" as 10 minutes in the future rather than sleeping.
        $future = (Get-Date).AddSeconds(601)
        $h = Test-CtgRunnerHealth -Path $script:hb -TimeoutSeconds 600 -Now $future
        $h.healthy    | Should -BeFalse
        $h.ageSeconds | Should -BeGreaterThan 600
        $h.reason     | Should -Match 'no progress'
    }
}

Describe 'Update-CtgHeartbeat' {
    It 'writes the file and records the phase in its body' {
        $p = Join-Path ([System.IO.Path]::GetTempPath()) "wd-test-$([guid]::NewGuid()).heartbeat"
        try {
            Update-CtgHeartbeat -Path $p -Phase 'connecting to m365'
            Test-Path -LiteralPath $p | Should -BeTrue
            (Get-Content -LiteralPath $p -Raw) | Should -Match 'connecting to m365'
        } finally {
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
        }
    }
}

Describe 'Get-CtgHeartbeatPath' {
    It 'honors an explicit path' {
        Get-CtgHeartbeatPath -Explicit '/tmp/explicit.hb' -AgentId 'agent1' | Should -Be '/tmp/explicit.hb'
    }
    It 'defaults to a temp path keyed by the agent id' {
        $env:RUNNER_HEARTBEAT_FILE = $null
        Get-CtgHeartbeatPath -AgentId 'agentXYZ' | Should -Match 'iam-runner-agentXYZ\.heartbeat$'
    }
}
