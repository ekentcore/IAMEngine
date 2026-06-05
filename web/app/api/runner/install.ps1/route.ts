// GET /api/runner/install.ps1?token=<enrollToken> — returns a self-contained PowerShell installer.
// One-liner usage (shown on /agents):  irm http://<app>/api/runner/install.ps1?token=… | iex
//
// The route verifies the enroll token, derives the app URL from the request, and bakes scope/client
// + token + appUrl into the script. The script: installs modules (scope-aware), downloads the runner
// via the manifest+file API, auto-enrolls (token -> agent id), registers a "iam-runner" Scheduled
// Task (at startup, restart on failure), and starts it. Idempotent and re-runnable.
import { verifyEnrollToken, enrollSecret } from "@/lib/runner/enroll-token";

export const dynamic = "force-dynamic";

const ps = (s: string) => new Response(s, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const claims = verifyEnrollToken(token, enrollSecret(), Date.now());
  if (!claims) {
    return ps(`Write-Error "Runner install link is invalid or expired. Generate a fresh one from the Agents page."`);
  }
  // App URL the installer talks back to = the host the operator actually connected to (the Host
  // header reflects the copied install URL's host, e.g. the Mac's LAN IP — not the 0.0.0.0 bind).
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (url.protocol.replace(":", "") || "http");
  const appUrl = host ? `${proto}://${host}` : url.origin;
  const scope = claims.scope;
  const client = claims.client ?? "";
  const needAd = scope === "client_network"; // on-prem AD only for a client-network agent
  const installDir = "C:\\iam-runner";
  const agentName = scope === "client_network" ? `runner-${client}-$env:COMPUTERNAME` : `central-$env:COMPUTERNAME`;

  const script = `#Requires -Version 5.1
# iam-engine runner installer (scope=${scope}${client ? `, client=${client}` : ""}). Re-runnable.
$ErrorActionPreference = 'Stop'
$AppUrl    = '${appUrl}'
$Token     = '${token}'
$InstallDir= '${installDir}'
$NeedAd    = $${needAd ? "true" : "false"}

function Step($m) { Write-Host "  -> $m" -ForegroundColor Cyan }
Write-Host "iam-engine runner install" -ForegroundColor Green

# 0. Admin check (module install + scheduled task need it)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Warning "Not elevated — re-run in an *Administrator* PowerShell."; return }

# 1. PowerShell 7 (the runner requires it; we install jobs run under pwsh)
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) {
  Step "installing PowerShell 7 via winget"
  winget install --id Microsoft.PowerShell --silent --accept-source-agreements --accept-package-agreements
  $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwsh) { Write-Error "PowerShell 7 not found after install — install it and re-run."; return }
}

# 2. Required modules
Step "installing modules (Graph, ExchangeOnlineManagement$(if ($NeedAd) { ', ActiveDirectory (RSAT)' }))"
if (-not (Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue)) { Register-PSRepository -Default }
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
foreach ($m in @('Microsoft.Graph','ExchangeOnlineManagement')) {
  if (-not (Get-Module -ListAvailable -Name $m)) { Install-Module $m -Scope AllUsers -Force -AcceptLicense }
}
if ($NeedAd -and -not (Get-Module -ListAvailable -Name ActiveDirectory)) {
  $cap = Get-WindowsCapability -Online -Name 'Rsat.ActiveDirectory*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cap) { Add-WindowsCapability -Online -Name $cap.Name } else { Write-Warning "RSAT ActiveDirectory not available here — install it on a domain-joined host." }
}

# ngrok-skip-browser-warning bypasses ngrok-free's HTML interstitial (harmless on other hosts).
$H = @{ 'ngrok-skip-browser-warning' = 'true' }

# 3. Download the runner (manifest + per-file)
Step "downloading runner -> $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H
foreach ($rel in $manifest.files) {
  $dest = Join-Path $InstallDir ($rel -replace '/', '\\')
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  $body = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H
  [System.IO.File]::WriteAllText($dest, $body.Content)
}

# 4. Auto-enroll (token -> agent id; the token carries scope + client)
Step "enrolling agent"
$enroll = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/agents" -ContentType 'application/json' -Headers $H -Body (@{ name = "${agentName}"; enrollToken = $Token } | ConvertTo-Json)
$AgentId = $enroll.id
if (-not $AgentId) { Write-Error "Enrollment failed (no agent id returned)."; return }
Write-Host "  enrolled: $AgentId" -ForegroundColor Green

# 5. Register + start a Scheduled Task (at startup, restart on failure)
Step "registering Scheduled Task 'iam-runner'"
$start = Join-Path $InstallDir 'Start-IamRunner.ps1'
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $start + '" -AppUrl "' + $AppUrl + '" -AgentId "' + $AgentId + '"'
$action  = New-ScheduledTaskAction -Execute $pwsh -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings= New-ScheduledTaskSettingsSet -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName 'iam-runner' -Confirm:$false -ErrorAction SilentlyContinue
# Runs as SYSTEM. For AD/Exchange writes, set this task's run-as to a service account with rights,
# OR rely on the brokered ad-dc credential — see docs. (SYSTEM is fine for a connectivity test.)
Register-ScheduledTask -TaskName 'iam-runner' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName 'iam-runner'

Write-Host ""
Write-Host "Done. Runner '$AgentId' installed at $InstallDir and started (Scheduled Task 'iam-runner')." -ForegroundColor Green
Write-Host "It should appear Online on the Agents page within ~30s." -ForegroundColor Green
`;
  return ps(script);
}
