#Requires -Version 7.0
<#
.SYNOPSIS
    Standalone keep-alive supervisor for an iam-engine runner. Install it pointing at a runner's info;
    it restarts that runner if it STOPS WORKING — whether the process exited/crashed OR it wedged
    (heartbeat went stale). It can kill a lingering/stuck process and relaunch a fresh one.

.DESCRIPTION
    Use this where there's no OS service manager keeping the runner up (a plain box, a hand-started
    runner), or as belt-and-suspenders alongside one. It reuses the runner's own heartbeat + health
    check (Coretelligent.Watchdog) and finds the runner process by its lock file / agent id.

    TWO MODES (who keeps the keep-alive alive?):
      -Once   : do a single check + heal, then exit. Drive it from cron / Task Scheduler every minute —
                the OS scheduler keeps IT alive, so the supervisor needs no supervisor. (Recommended.)
      (loop)  : default — run forever, checking every -CheckIntervalSeconds. Simple to nohup/background.

.EXAMPLE
    pwsh -File Keep-IamRunnerAlive.ps1 -AppUrl https://iam-engine.internal -AgentId cmq585... -Once
.EXAMPLE
    pwsh -File Keep-IamRunnerAlive.ps1 -AppUrl http://localhost:3000 -AgentId cmq585...   # loop
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppUrl,
    [Parameter(Mandatory)][string]$AgentId,
    [string]$RunnerDir = $PSScriptRoot,                 # where Start-IamRunner.ps1 lives
    [int]$StallTimeoutSeconds = 600,                    # heartbeat older than this = wedged (matches the runner)
    [int]$CheckIntervalSeconds = 30,                    # loop mode: how often to check
    [int]$PollSeconds = 5,
    [int]$BatchSize = 5,
    [string]$ExoModuleVersion = '3.9.2',
    [string]$ApiToken = $env:RUNNER_API_TOKEN,
    [string]$HeartbeatFile = '',                        # explicit; else derived from AgentId
    [switch]$Once                                       # single check + exit (for cron / Task Scheduler)
)

$ErrorActionPreference = 'Stop'
$wd = Join-Path $RunnerDir 'lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1'
if (-not (Test-Path -LiteralPath $wd)) { throw "can't find the watchdog module at $wd — point -RunnerDir at the folder containing Start-IamRunner.ps1." }
Import-Module $wd -Force

$script:HbPath  = Get-CtgHeartbeatPath -Explicit $HeartbeatFile -AgentId $AgentId
$script:Self    = Join-Path $RunnerDir 'Start-IamRunner.ps1'
$script:LockPath = Join-Path $RunnerDir '.runner.lock'
$script:LogPath = if ($env:RUNNER_LOG) { $env:RUNNER_LOG } else { Join-Path $HOME 'iam-runner.log' }
if (-not (Test-Path -LiteralPath $script:Self)) { throw "can't find the runner at $($script:Self) — check -RunnerDir." }
$pwshPath = (Get-Process -Id $PID).Path; if (-not $pwshPath) { $pwshPath = (Get-Command pwsh).Source }

function Write-KaLog([string]$Message) {
    $line = "[$([DateTime]::Now.ToString('o'))] keep-alive($AgentId): $Message"
    Write-Host $line
    try { Add-Content -LiteralPath $script:LogPath -Value $line } catch { }
}

function Get-RunnerPid {
    # The live runner PID for THIS agent: prefer the lock file it writes, else find the process by its
    # command line (cross-platform). Returns $null when no runner process is found.
    try {
        if (Test-Path -LiteralPath $script:LockPath) {
            $p = ([System.IO.File]::ReadAllText($script:LockPath)).Trim()
            if ($p -and (Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue)) { return [int]$p }
        }
    } catch { }
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='pwsh'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'Start-IamRunner' -and $_.CommandLine -match [regex]::Escape($AgentId) }
        if ($procs) { return [int]($procs | Select-Object -First 1).ProcessId }
    } catch { }
    try {
        $found = & pgrep -f "Start-IamRunner.*$([regex]::Escape($AgentId))" 2>$null | Select-Object -First 1
        if ($found) { return [int]$found }
    } catch { }
    return $null
}

function Stop-Runner([int]$RunnerPid) {
    if (-not $RunnerPid) { return }
    Write-KaLog "killing stuck runner process (pid $RunnerPid)"
    try { Stop-Process -Id $RunnerPid -Force -ErrorAction Stop } catch { Write-KaLog "couldn't kill pid ${RunnerPid}: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
}

function Start-Runner {
    # Relaunch the runner DETACHED, supervised by US (RUNNER_SUPERVISED=1 — so on a self-update it just
    # exits and we relaunch it, no double process). Output appends to the shared runner log.
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:Self, '-AppUrl', $AppUrl, '-AgentId', $AgentId,
        '-PollSeconds', "$PollSeconds", '-BatchSize', "$BatchSize", '-ExoModuleVersion', $ExoModuleVersion, '-StallTimeoutSeconds', "$StallTimeoutSeconds")
    if ($ApiToken) { $a += @('-ApiToken', $ApiToken) }
    $env:RUNNER_SUPERVISED = '1'
    Write-KaLog "starting runner -> $($script:Self)"
    if ($IsWindows) {
        Start-Process -FilePath $pwshPath -ArgumentList $a -WindowStyle Hidden | Out-Null
    }
    else {
        # Detach from this process + tty so the runner survives the keep-alive (esp. -Once exiting).
        $q = { param($s) "'" + ([string]$s -replace "'", "'\''") + "'" }
        $line = (@($pwshPath) + $a | ForEach-Object { & $q $_ }) -join ' '
        $launcher = Join-Path ([System.IO.Path]::GetTempPath()) "iam-keepalive-launch-$AgentId.sh"
        [System.IO.File]::WriteAllText($launcher, "#!/bin/sh`nexport RUNNER_SUPERVISED=1`nexec $line >> $(& $q $script:LogPath) 2>&1`n")
        Start-Process -FilePath '/bin/sh' -ArgumentList $launcher | Out-Null
    }
}

function Invoke-KeepAliveCheck {
    $runnerPid = Get-RunnerPid
    $health = Test-CtgRunnerHealth -Path $script:HbPath -TimeoutSeconds $StallTimeoutSeconds
    $decision = Get-CtgKeepAliveAction -ProcessAlive ([bool]$runnerPid) -Health $health
    if ($decision.action -eq 'ok') { return }
    Write-KaLog "RESTART — $($decision.reason)"
    if ($runnerPid) { Stop-Runner $runnerPid }    # kill a wedged-but-alive process before relaunching
    Start-Runner
}

Write-KaLog "watching runner (heartbeat $($script:HbPath); stall ${StallTimeoutSeconds}s; mode $(if ($Once) { 'once' } else { "loop/${CheckIntervalSeconds}s" }))"
if ($Once) {
    Invoke-KeepAliveCheck
}
else {
    while ($true) {
        try { Invoke-KeepAliveCheck } catch { Write-KaLog "check error (continuing): $($_.Exception.Message)" }
        Start-Sleep -Seconds $CheckIntervalSeconds
    }
}
