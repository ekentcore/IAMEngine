<#
.SYNOPSIS
  Update + relaunch the Windows (client-network/DC) iam-engine runner locally, bypassing the in-app
  self-update if it stalls. Stops the running runner, re-pulls the bundle with request timeouts, and
  relaunches it. Run in pwsh 7 on the DC.

.EXAMPLE
  pwsh -File C:\iam-runner\update-dc-runner.ps1 -AppUrl http://192.168.0.81:3000 -AgentId <id>
  # AppUrl/AgentId default to the values baked in below; override as needed.
#>
[CmdletBinding()]
param(
  [string]$AppUrl   = "http://192.168.0.81:3000",
  [string]$AgentId  = "runner-coretelligent-CORE-CCE-DC01",
  [string]$Dir      = "C:\iam-runner",
  [string]$ApiToken = $env:RUNNER_API_TOKEN
)

$ErrorActionPreference = 'Stop'
$H = @{ 'ngrok-skip-browser-warning' = 'true' }
if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }

Write-Host "==> stopping any running runner" -ForegroundColor Cyan
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Start-IamRunner' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; "stopped pid $($_.ProcessId)" } catch {} }
Start-Sleep -Seconds 1

Write-Host "==> fetching manifest from $AppUrl" -ForegroundColor Cyan
$manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H -TimeoutSec 30
Write-Host "    build $($manifest.buildId) — $($manifest.files.Count) files"

Write-Host "==> downloading into $Dir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force $Dir | Out-Null
foreach ($rel in $manifest.files) {
  $dest = Join-Path $Dir $rel
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  $resp = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H -TimeoutSec 60
  [System.IO.File]::WriteAllText($dest, $resp.Content)
  Write-Host "    $rel" -ForegroundColor DarkGray
}

Write-Host "==> relaunching runner ($AgentId)" -ForegroundColor Cyan
$self = Join-Path $Dir 'Start-IamRunner.ps1'
$pwshPath = (Get-Process -Id $PID).Path
# WMI Win32_Process.Create so the new process survives this script's exit (and any Scheduled Task job object).
$qq = { param([string]$s) '"' + ($s -replace '"', '\"') + '"' }
$cmd = (& $qq $pwshPath) + ' -NoProfile -ExecutionPolicy Bypass -File ' + (& $qq $self) +
       ' -AppUrl ' + (& $qq $AppUrl) + ' -AgentId ' + (& $qq $AgentId)
if ($ApiToken) { $cmd += ' -ApiToken ' + (& $qq $ApiToken) }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -eq 0) { Write-Host "    relaunched (pid $($r.ProcessId)) on build $($manifest.buildId)" -ForegroundColor Green }
else { Write-Warning "relaunch returned $($r.ReturnValue); start it manually: $cmd" }
