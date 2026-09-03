# A wedged runner used to leave its job in limbo: the stall watchdog kills the process, but the APP
# only finds out when the 10-minute claim lease expires — it then re-queues the job once and fails it
# some time after that. From an operator's seat that is half an hour of a step sitting at "running"
# with no explanation, which is exactly how the 2026-09-03 ExchangeOnlineManagement wedge presented.
#
# The in-flight marker closes that: the running job is stamped on disk, cleared when it finishes, and
# any marker still lying there at the next start is reported as a failure with a real reason.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# ConnectionCache and SelfHealModuleConflict tests — we extract the functions and evaluate those.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    foreach ($fn in 'Set-CtgInFlight', 'Clear-CtgInFlight', 'Report-CtgAbandonedJob') {
        $m = [regex]::Match($script:Runner, "(?ms)^function $([regex]::Escape($fn)) \{.*?^\}")
        $m.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare $fn"
        . ([scriptblock]::Create($m.Value))
    }
    # Write-CtgLog belongs to the runner script; stub it so the extracted functions can call it.
    function global:Write-CtgLog { param($Level, $Message) }
}

Describe 'the in-flight marker' {
    BeforeEach {
        $script:CtgInFlightFile = Join-Path $TestDrive "inflight-$([guid]::NewGuid()).json"
    }

    It 'records the running job and clears it when the job finishes' {
        Set-CtgInFlight ([pscustomobject]@{ id = 'job1'; systemKey = 'm365'; action = 'offboard'; caseNumber = 'UM0030906' })
        Test-Path $script:CtgInFlightFile | Should -BeTrue
        (Get-Content $script:CtgInFlightFile -Raw | ConvertFrom-Json).jobId | Should -Be 'job1'

        Clear-CtgInFlight
        Test-Path $script:CtgInFlightFile | Should -BeFalse
    }

    It 'clearing a marker that was never written is a no-op, not an error' {
        { Clear-CtgInFlight } | Should -Not -Throw
    }
}

Describe 'Report-CtgAbandonedJob' {
    BeforeEach {
        $script:CtgInFlightFile = Join-Path $TestDrive "inflight-$([guid]::NewGuid()).json"
    }

    It 'reports the job the previous process died on, and says why' {
        Set-CtgInFlight ([pscustomobject]@{ id = 'job1'; systemKey = 'm365'; action = 'offboard'; caseNumber = 'UM0030906' })
        # A List, not @() with +=: inside the scriptblock '+=' rebinds a LOCAL copy and the outer
        # variable stays empty, which silently turns every count assertion below into a no-op.
        $posted = [System.Collections.Generic.List[object]]::new()
        $id = Report-CtgAbandonedJob -Post { param($JobId, $Why) $posted.Add(@{ JobId = $JobId; Why = $Why }) }

        $id | Should -Be 'job1'
        $posted.Count | Should -Be 1
        $posted[0].JobId | Should -Be 'job1'
        $posted[0].Why | Should -Match 'the runner stopped while this step was running'
        $posted[0].Why | Should -Match 're-run this step'
    }

    It 'clears the marker so the SAME job is not re-reported on every boot' {
        # A marker left behind would fail the job again after every restart — including restarts that
        # had nothing to do with it.
        Set-CtgInFlight ([pscustomobject]@{ id = 'job1'; systemKey = 'm365'; action = 'offboard'; caseNumber = 'x' })
        $null = Report-CtgAbandonedJob -Post { param($JobId, $Why) }
        Test-Path $script:CtgInFlightFile | Should -BeFalse

        $second = [System.Collections.Generic.List[object]]::new()
        $null = Report-CtgAbandonedJob -Post { param($JobId, $Why) $second.Add($JobId) }
        $second.Count | Should -Be 0
    }

    It 'does nothing on a clean start (no marker)' {
        $posted = [System.Collections.Generic.List[object]]::new()
        $id = Report-CtgAbandonedJob -Post { param($JobId, $Why) $posted.Add($JobId) }
        $id | Should -BeNullOrEmpty
        $posted.Count | Should -Be 0
    }

    It 'clears an unparseable marker instead of retrying it forever' {
        Set-Content -Path $script:CtgInFlightFile -Value 'not json at all' -Encoding utf8
        $posted = [System.Collections.Generic.List[object]]::new()
        $id = Report-CtgAbandonedJob -Post { param($JobId, $Why) $posted.Add($JobId) }
        $id | Should -BeNullOrEmpty
        $posted.Count | Should -Be 0
        Test-Path $script:CtgInFlightFile | Should -BeFalse
    }

    It 'survives a post that throws — recovery must never stop the runner starting' {
        Set-CtgInFlight ([pscustomobject]@{ id = 'job1'; systemKey = 'm365'; action = 'offboard'; caseNumber = 'x' })
        { Report-CtgAbandonedJob -Post { param($JobId, $Why) throw 'app unreachable' } } | Should -Not -Throw
        Test-Path $script:CtgInFlightFile | Should -BeFalse
    }
}

Describe 'the job loop keeps the marker honest' {
    It 'stamps the marker when a job starts and clears it in the finally' {
        # If the stamp were missing nothing would ever be recovered; if the clear were missing every
        # completed job would be re-reported as failed on the next restart. Both directions matter.
        $script:Runner | Should -Match 'Set-CtgInFlight \$job'
        $loopFinally = [regex]::Match($script:Runner, '(?ms)finally \{\s*\r?\n\s*Clear-CtgInFlight')
        $loopFinally.Success | Should -BeTrue -Because 'the clear must be in the job loop finally, so it runs on success AND failure'
    }
}
