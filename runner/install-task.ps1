#Requires -Version 7.0
<#
  install-task.ps1 — the Windows equivalent of install-launchd.sh. Registers a Scheduled Task that
  keeps the iam-engine runner alive on a DC / Windows host: starts it at boot and re-launches it within
  a minute on ANY exit (crash, the stall watchdog's restart, or a supervised self-update).

  Keep-alive trick (Task Scheduler has no "restart on any exit"): the task triggers at startup AND
  repeats every minute forever, with MultipleInstances=IgnoreNew — so while the runner is alive the
  re-trigger is ignored (the runner's own .runner.lock also guards against doubles), and the moment it's
  gone the next tick starts a fresh one. RUNNER_SUPERVISED=1 (machine env) tells the runner to just exit
  on self-update and let the task relaunch it.

  Run ELEVATED. Example:
    pwsh -File install-task.ps1 -AppUrl https://iamsetup.kentassociates.org -AgentId cmqlj5d4t00035r7wx941ce4a -RunnerApiToken <token>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$AppUrl,
  [Parameter(Mandatory)][string]$AgentId,
  [string]$InstallDir = 'C:\iam-runner',
  [string]$Pwsh = '',                          # default: this pwsh
  [int]$StallTimeoutSeconds = 600,
  [string]$TaskName = 'iam-runner',
  [string]$RunnerApiToken = $env:RUNNER_API_TOKEN,   # bearer for the app's runner APIs; required once the app fails-closed
  # PoolSize=1 (default) supervises Start-IamRunner.ps1 directly — byte-identical to the single-agent
  # task. PoolSize>1 supervises Start-IamRunnerPool.ps1 (N distinct-identity members; needs feature #4's
  # governor active, else the pool refuses >1 and runs a single member).
  [int]$PoolSize = 1,
  [string]$RunnerEnrollToken = $env:RUNNER_ENROLL_TOKEN   # signed enroll token so the pool can mint members #1..N-1
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'install-task.ps1 is Windows-only — use install-launchd.sh on macOS/Linux.' }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Not elevated — re-run in an Administrator PowerShell (registering a SYSTEM task needs it).'
}
if (-not $Pwsh) { $Pwsh = (Get-Process -Id $PID).Path; if (-not $Pwsh) { $Pwsh = (Get-Command pwsh).Source } }
$script = Join-Path $InstallDir 'Start-IamRunner.ps1'
if (-not (Test-Path $script)) { throw "runner not found at $script — pull it first (Setup-IamRunner.ps1), or set -InstallDir." }
if ($PoolSize -gt 1) {
  $script = Join-Path $InstallDir 'Start-IamRunnerPool.ps1'
  if (-not (Test-Path $script)) { throw "pool supervisor not found at $script — pull a runner build >= 1.95.0, or set -InstallDir." }
}

# The runner reads RUNNER_SUPERVISED + RUNNER_API_TOKEN from env; set them Machine-wide so the SYSTEM
# task inherits them (the token is NOT put on the task's command line, so it's not visible in the task
# definition / Get-ScheduledTask). Without this, a Windows agent starts unauthenticated and 401s the
# moment the app enforces the token — the exact lockout we hit before.
[Environment]::SetEnvironmentVariable('RUNNER_SUPERVISED', '1', 'Machine')
if (-not [string]::IsNullOrWhiteSpace($RunnerApiToken)) {
  [Environment]::SetEnvironmentVariable('RUNNER_API_TOKEN', $RunnerApiToken, 'Machine')
  Write-Host 'set RUNNER_API_TOKEN (Machine env) — the runner will authenticate to the app.' -ForegroundColor Green
} else {
  Write-Host 'WARN no -RunnerApiToken given and $env:RUNNER_API_TOKEN is empty — the agent will NOT authenticate; it will 401 once the app fails-closed. Re-run with -RunnerApiToken <token> (get it from Agents > Add runner, or the admin runner-token endpoint).' -ForegroundColor Yellow
}
# Pool enroll token (Machine env, out of the task command line) so the supervisor can mint members.
if (-not [string]::IsNullOrWhiteSpace($RunnerEnrollToken)) {
  [Environment]::SetEnvironmentVariable('RUNNER_ENROLL_TOKEN', $RunnerEnrollToken, 'Machine')
  $env:RUNNER_ENROLL_TOKEN = $RunnerEnrollToken
}

# Size 1 = the runner directly (unchanged arg string); size >1 = the pool supervisor with -PoolSize.
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -AppUrl `"$AppUrl`" -AgentId `"$AgentId`" -StallTimeoutSeconds $StallTimeoutSeconds"
if ($PoolSize -gt 1) {
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -AppUrl `"$AppUrl`" -AgentId `"$AgentId`" -PoolSize $PoolSize -StallTimeoutSeconds $StallTimeoutSeconds"
}
$action = New-ScheduledTaskAction -Execute $Pwsh -Argument $arg -WorkingDirectory $InstallDir

# Trigger: at startup + repeat every 1 minute indefinitely (the keep-alive heartbeat).
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

# Run as SYSTEM (survives logoff; inherits the Machine env vars Setup-IamRunner.ps1 sets), highest priv.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "registered + started Scheduled Task '$TaskName' (SYSTEM; starts at boot, self-heals every minute)." -ForegroundColor Green
Write-Host "  status:  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "  restart: Restart-ScheduledTask -TaskName $TaskName"
Write-Host "  remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
