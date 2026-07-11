// Generates the per-agent troubleshoot script served by /api/runner/troubleshoot.ps1.
//
// The script diagnoses the "enrolled but never heartbeats" runner (the Agents page shows
// "pre-build runner" forever and a queued update is never delivered, because updates are only
// delivered in the heartbeat response). It checks each layer in order — pwsh 7, runner files,
// the Scheduled Task, the machine-level RUNNER_API_TOKEN, reachability, then auth — and ends
// with a verdict plus an optional foreground run with the right -AppUrl/-AgentId/-ApiToken.
//
// Runs on Windows PowerShell 5.1 (the default console on a fresh server) as well as pwsh 7,
// so every check degrades gracefully: no ternaries, no $IsWindows, -UseBasicParsing everywhere.

// PowerShell single-quoted literal: only ' needs escaping (doubled). Keeps a hostile query
// param from breaking out of the string in the served script.
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function troubleshootScript(appUrl: string, agentId: string): string {
  return `# iam-runner troubleshoot — run in PowerShell (5.1 or 7) on the RUNNER HOST. Read-only except the optional foreground run at the end.
$ErrorActionPreference = 'Continue'
$App = ${psq(appUrl)}
$AgentId = ${psq(agentId)}
$H = @{ 'ngrok-skip-browser-warning' = 'true' }   # bypasses ngrok-free's HTML interstitial; harmless elsewhere
function OK($m)   { Write-Host ("  [ OK ] " + $m) -ForegroundColor Green }
function BAD($m)  { Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }
function INFO($m) { Write-Host ("  [ -- ] " + $m) -ForegroundColor Yellow }
Write-Host "iam-runner troubleshoot  (agent $AgentId via $App)" -ForegroundColor Cyan

# 1. PowerShell 7 — the runner requires it (#Requires -Version 7.0).
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $p7 = Join-Path (Join-Path (Join-Path $env:ProgramFiles 'PowerShell') '7') 'pwsh.exe'; if (Test-Path $p7) { $pwsh = $p7 } }
if ($pwsh) { OK "PowerShell 7: $pwsh" } else { BAD "PowerShell 7 not found - install from https://aka.ms/powershell, then re-run" }

# 2. Runner files — the Windows installer uses C:\\iam-runner; the copy-paste install uses $HOME/iam-runner.
$Dir = $null
foreach ($d in @('C:\\iam-runner', (Join-Path $HOME 'iam-runner'))) {
  # slash-join, not Join-Path: 'C:\\...' makes Join-Path throw "cannot find drive C" on macOS/Linux
  if (Test-Path -LiteralPath "$d/Start-IamRunner.ps1" -ErrorAction SilentlyContinue) { $Dir = $d; break }
}
if ($Dir) { OK "runner files: $Dir" } else { BAD "Start-IamRunner.ps1 not found in C:\\iam-runner or $HOME/iam-runner - run the installer first" }

# 3. Scheduled Task (Windows service install). Missing is fine for a foreground/manual runner.
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
  $task = Get-ScheduledTask -TaskName 'iam-runner' -ErrorAction SilentlyContinue
  if ($task) {
    $ti = $task | Get-ScheduledTaskInfo
    if ($task.State -eq 'Running') { OK ("task 'iam-runner': Running (last result " + $ti.LastTaskResult + ")") }
    else { INFO ("task 'iam-runner': " + $task.State + ", last run " + $ti.LastRunTime + ", last result " + $ti.LastTaskResult + " (0 = ok)") }
  } else { INFO "no 'iam-runner' Scheduled Task (fine if this runner is started by hand / launchd / systemd)" }
} else { INFO "Scheduled Task cmdlets unavailable (not Windows) - skipping task check" }

# 4. Is a runner process actually running right now?
$proc = $null
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
  $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*Start-IamRunner*' } | Select-Object -First 1
}
if ($proc) { OK ("runner process running (pid " + $proc.ProcessId + ")") } else { INFO "no Start-IamRunner process is running on this host" }

# 5. Bearer token — the SYSTEM task reads RUNNER_API_TOKEN from the MACHINE environment.
$tok = [Environment]::GetEnvironmentVariable('RUNNER_API_TOKEN', 'Machine')
if (-not $tok) { $tok = $env:RUNNER_API_TOKEN }
if ($tok) { OK "RUNNER_API_TOKEN is set (machine or session env)" } else { INFO "RUNNER_API_TOKEN is NOT set - required if the app enforces runner auth" }

# 6. Reachability — /api/runner/manifest is unauthenticated, so this isolates pure network problems.
$reach = $false
try {
  $man = Invoke-RestMethod -Uri "$App/api/runner/manifest" -Headers $H -TimeoutSec 15
  $reach = $true; OK ("app reachable - current runner build " + $man.buildId)
} catch { BAD ("cannot reach $App - " + $_.Exception.Message) }

# 7. Auth — POST a heartbeat with a PROBE agent id (never the real one: a real heartbeat would
# consume a queued update/restart and fake this agent's 'last seen'). 404 unknown agent = auth OK.
$authOk = $false
if ($reach) {
  $HA = @{} + $H; if ($tok) { $HA['Authorization'] = "Bearer $tok" }
  $code = 0
  try {
    Invoke-WebRequest -Uri "$App/api/agents/heartbeat" -Method Post -ContentType 'application/json' -Body '{"agentId":"troubleshoot-probe"}' -Headers $HA -UseBasicParsing -TimeoutSec 15 | Out-Null
    $code = 200
  } catch { try { $code = [int]$_.Exception.Response.StatusCode } catch { } }
  if ($code -eq 404) { $authOk = $true; OK "runner API auth accepted this host's token" }
  elseif ($code -eq 401) { BAD "runner API rejected the token (401) - this host's RUNNER_API_TOKEN is missing or doesn't match the app's" }
  elseif ($code -eq 503) { BAD "app says runner auth is not configured (503) - set RUNNER_API_TOKEN on the app server" }
  else { BAD ("unexpected response from the heartbeat endpoint (HTTP " + $code + ")") }
}

# Verdict.
Write-Host ""
if (-not $reach) {
  Write-Host "VERDICT: this host cannot reach the app. Fix network/tunnel/proxy first - nothing else matters until it can." -ForegroundColor Red
} elseif (-not $authOk) {
  Write-Host "VERDICT: the app is reachable but rejects this host's credentials. Fix RUNNER_API_TOKEN (installer step 4b sets it machine-wide), then REBOOT - a SYSTEM Scheduled Task only picks up new machine env vars after a reboot." -ForegroundColor Red
} elseif ($proc) {
  Write-Host "VERDICT: everything checks out from THIS session, and a runner process is running. If the Agents page still shows this runner offline / 'pre-build', that process started before the token landed: REBOOT this host (the Task Scheduler service caches machine env vars until reboot)." -ForegroundColor Yellow
} else {
  Write-Host "VERDICT: connectivity and auth are fine but no runner is running. Start it below (or Start-ScheduledTask iam-runner) - it takes over any stale instance safely." -ForegroundColor Yellow
}

# Optional: run the runner in the FOREGROUND so you can watch it live. A new instance takes over
# the runner lock, so any half-alive old process exits itself - safe to run over the task.
if ($pwsh -and $Dir) {
  $go = Read-Host "Run the runner in the foreground now to watch it live? (y/N)"
  if ($go -match '^[Yy]') {
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'Start-IamRunner.ps1') -AppUrl $App -AgentId $AgentId -ApiToken $tok
  }
}
`;
}
