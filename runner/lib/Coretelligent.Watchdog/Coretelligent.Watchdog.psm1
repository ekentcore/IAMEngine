# Coretelligent.Watchdog — independent stall watchdog + liveness signal for the runner.
#
# The runner runs jobs INLINE on one thread, so a hung native call (a wedged Exchange Online cmdlet)
# blocks the heartbeat loop and the process can't recover itself through the normal loop — nothing in
# that loop runs while the thread is blocked. This module adds an INDEPENDENT watchdog on its own
# runspace/thread that watches a heartbeat file (touched by the main loop + every progress narration)
# and force-restarts the process when it goes stale. The same freshness signal powers
# Test-CtgRunnerHealth, which backs the runner's -HealthCheck CLI mode — a drop-in Azure Container
# Apps `exec` liveness probe when this moves to managed hosting (the platform restarts the wedged
# replica instead of launchd/Task Scheduler).

function Get-CtgHeartbeatPath {
    # The heartbeat file path, shared by the running runner, its watchdog, and the -HealthCheck probe.
    # Kept OUTSIDE the runner folder (system temp) so it never affects the bundle hash. Overridable via
    # -Explicit or $env:RUNNER_HEARTBEAT_FILE (e.g. a fixed path the container's liveness probe reads).
    param([string]$Explicit, [Parameter(Mandatory)][string]$AgentId)
    if ($Explicit) { return $Explicit }
    if ($env:RUNNER_HEARTBEAT_FILE) { return $env:RUNNER_HEARTBEAT_FILE }
    return (Join-Path ([System.IO.Path]::GetTempPath()) "iam-runner-$AgentId.heartbeat")
}

function Update-CtgHeartbeat {
    # Stamp the heartbeat file = "I made progress just now". The file's mtime IS the signal; the body
    # (unix seconds + the current phase) is a human-readable bonus for the health probe. Best-effort —
    # must never throw into the job it's narrating.
    param([Parameter(Mandatory)][string]$Path, [string]$Phase = '')
    try { [System.IO.File]::WriteAllText($Path, "$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())`n$Phase") } catch { }
}

function Test-CtgStalled {
    # Pure decision (unit-tested): has it been longer than TimeoutSeconds since the last activity?
    param(
        [Parameter(Mandatory)][datetime]$LastActivity,
        [Parameter(Mandatory)][datetime]$Now,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )
    return (($Now - $LastActivity).TotalSeconds -gt $TimeoutSeconds)
}

function Test-CtgRunnerHealth {
    # Read the heartbeat file's freshness → @{ healthy; ageSeconds; reason }. Fails SAFE: a missing
    # file (not started yet) or an unreadable one is reported healthy — we never kill a runner we can't
    # prove is wedged. Only a present-but-stale heartbeat is unhealthy.
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [datetime]$Now = (Get-Date)
    )
    if (-not (Test-Path -LiteralPath $Path)) { return @{ healthy = $true; ageSeconds = 0; reason = 'no heartbeat file yet (starting)' } }
    try {
        $last = (Get-Item -LiteralPath $Path).LastWriteTime
        $age = [int]($Now - $last).TotalSeconds
        if (Test-CtgStalled -LastActivity $last -Now $Now -TimeoutSeconds $TimeoutSeconds) {
            return @{ healthy = $false; ageSeconds = $age; reason = "no progress for ${age}s (limit ${TimeoutSeconds}s)" }
        }
        return @{ healthy = $true; ageSeconds = $age; reason = 'fresh' }
    } catch {
        return @{ healthy = $true; ageSeconds = 0; reason = 'heartbeat unreadable (not killing)' }
    }
}

function Start-CtgWatchdog {
    # Arm the watchdog on its OWN runspace/thread so it keeps running while the main thread is blocked
    # in a native call. On stall it: (1) self-respawns a fresh process — so it recovers even with NO
    # supervisor — then (2) hard-exits, so a supervisor (launchd / Task Scheduler / Container Apps)
    # also relaunches. Belt-and-suspenders. Returns the runspace handles so the caller keeps them alive.
    param(
        [Parameter(Mandatory)][string]$HeartbeatFile,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [string]$PwshPath,
        [string[]]$RelaunchArgs,
        [int]$CheckSeconds = 30
    )
    $rs = [runspacefactory]::CreateRunspace(); $rs.Open()
    $ps = [powershell]::Create(); $ps.Runspace = $rs
    [void]$ps.AddScript({
        param($HeartbeatFile, $TimeoutSeconds, $PwshPath, $RelaunchArgs, $CheckSeconds)
        while ($true) {
            Start-Sleep -Seconds $CheckSeconds
            $stale = $false; $age = 0
            try {
                if (Test-Path -LiteralPath $HeartbeatFile) {
                    # Same comparison as Test-CtgStalled (inlined — a fresh runspace can't see module fns).
                    $age = [int]((Get-Date) - (Get-Item -LiteralPath $HeartbeatFile).LastWriteTime).TotalSeconds
                    if ($age -gt $TimeoutSeconds) { $stale = $true }
                }
            } catch { }
            if ($stale) {
                $msg = "[$([DateTime]::Now.ToString('o'))] watchdog: no progress for ${age}s (limit ${TimeoutSeconds}s) — restarting runner"
                try { [Console]::Error.WriteLine($msg) } catch { }
                # Under a supervisor (launchd / Task Scheduler / Container Apps — RUNNER_SUPERVISED=1)
                # just exit: it relaunches us, and self-respawning here would briefly double the process.
                # With NO supervisor, self-respawn first so a fresh instance takes over before we die.
                if (-not $env:RUNNER_SUPERVISED) {
                    try { if ($PwshPath -and $RelaunchArgs) { Start-Process -FilePath $PwshPath -ArgumentList $RelaunchArgs | Out-Null } } catch { }
                }
                Start-Sleep -Seconds 1
                [Environment]::Exit(75)
            }
        }
    }).AddArgument($HeartbeatFile).AddArgument($TimeoutSeconds).AddArgument($PwshPath).AddArgument($RelaunchArgs).AddArgument($CheckSeconds) | Out-Null
    [void]$ps.BeginInvoke()
    return @{ PowerShell = $ps; Runspace = $rs }
}

Export-ModuleMember -Function Get-CtgHeartbeatPath, Update-CtgHeartbeat, Test-CtgStalled, Test-CtgRunnerHealth, Start-CtgWatchdog
