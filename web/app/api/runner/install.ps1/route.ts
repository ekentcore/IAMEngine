// GET /api/runner/install.ps1?token=<enrollToken> — returns a self-contained PowerShell installer.
// One-liner usage (shown on /agents) downloads it to a FILE and runs it:
//   iwr "http://<app>/api/runner/install.ps1?token=…" -OutFile $f; powershell -ExecutionPolicy Bypass -File $f
// Add &download=1 to serve it as a browser download (Content-Disposition attachment) — the
// dialog's "Download install.ps1" button; the operator saves install-iam-runner.ps1 and runs it.
// Either way it must be a file on disk (not `irm | iex`) because the script re-launches ITSELF
// under pwsh 7 before installing modules. Installing them from the operator's Windows PowerShell
// 5.1 console is the "Import-Module says it's missing right after I installed it" trap: a
// CurrentUser install is invisible to the SYSTEM task, and 5.1-installed Graph builds can fail to
// import under pwsh 7. Installing BY pwsh 7 with -Scope AllUsers lands them where the runner's own
// runtime provably loads them (the script verifies the import before moving on).
//
// The route verifies the enroll token, derives the app URL from the request, and bakes scope/client
// + token + appUrl into the script. The script: ensures pwsh 7 and re-execs under it, installs the
// missing modules (scope-aware), downloads the runner via the manifest+file API, auto-enrolls
// (token -> agent id), registers a "iam-runner" Scheduled Task (at startup, restart on failure),
// and starts it. Idempotent and re-runnable.
import { verifyEnrollToken, enrollSecret } from "@/lib/runner/enroll-token";

export const dynamic = "force-dynamic";

// download=true adds a Content-Disposition attachment so a browser saves the file (named so the run
// command below matches) rather than rendering it inline; the `irm | iex` path leaves it inline.
const ps = (s: string, download = false) =>
  new Response(s, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...(download ? { "Content-Disposition": 'attachment; filename="install-iam-runner.ps1"' } : {}),
    },
  });

export function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const download = url.searchParams.get("download") === "1";
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
  // Bake the runner API bearer into the installer so the SYSTEM task authenticates once the app
  // fails-closed. Same trust boundary as the enroll token already embedded below: this script is only
  // served after verifyEnrollToken passes (a short-lived, operator-issued token).
  const apiToken = process.env.RUNNER_API_TOKEN ?? "";
  const needAd = scope === "client_network"; // on-prem AD only for a client-network agent
  const installDir = "C:\\iam-runner";
  const agentName = scope === "client_network" ? `runner-${client}-$env:COMPUTERNAME` : `central-$env:COMPUTERNAME`;

  const script = `#Requires -Version 5.1
# iam-engine runner installer (scope=${scope}${client ? `, client=${client}` : ""}). Re-runnable.
$ErrorActionPreference = 'Stop'
$AppUrl    = '${appUrl}'
$Token     = '${token}'
$ApiToken  = '${apiToken}'
$InstallDir= '${installDir}'
$NeedAd    = $${needAd ? "true" : "false"}

function Step($m) { Write-Host "  -> $m" -ForegroundColor Cyan }
Write-Host "iam-engine runner install" -ForegroundColor Green

# 0. Admin check (module install + scheduled task need it)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Warning "Not elevated — re-run in an *Administrator* PowerShell."; return }

# 1. PowerShell 7 (the runner requires it; jobs run under pwsh). winget isn't on Windows Server,
# so fall back to Microsoft's MSI installer script (works on Server / Core / older Windows).
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step "installing PowerShell 7 via winget"
    winget install --id Microsoft.PowerShell --silent --accept-source-agreements --accept-package-agreements
  } else {
    Step "installing PowerShell 7 via Microsoft's MSI script (no winget on this host)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-Expression "& { $(Invoke-RestMethod https://aka.ms/install-powershell.ps1) } -UseMSI -Quiet"
  }
  # PATH isn't refreshed in this session, so resolve pwsh's known install path directly.
  $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwsh) { $pwsh = Join-Path (Join-Path (Join-Path $env:ProgramFiles 'PowerShell') '7') 'pwsh.exe' }
  if (-not (Test-Path $pwsh)) { Write-Error "PowerShell 7 not found after install — install it from https://aka.ms/powershell and re-run."; return }
}

# 2. Re-exec under pwsh 7. Modules MUST be installed BY pwsh 7, machine-wide: a 5.1 CurrentUser
# install is invisible to the SYSTEM task, and 5.1-installed Graph builds can fail to import under
# pwsh 7 — either way the runner then fails Import-Module despite a "successful" install here.
# Installing from pwsh 7 with -Scope AllUsers lands them where the runner's runtime provably loads.
if ($PSVersionTable.PSVersion.Major -lt 7) {
  $self = $PSCommandPath
  if (-not $self) {
    # piped to iex (legacy one-liner) — persist a copy so pwsh 7 has a file to run
    $self = Join-Path $env:TEMP 'install-iam-runner.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri "$AppUrl/api/runner/install.ps1?token=$Token" -Headers @{ 'ngrok-skip-browser-warning' = 'true' } -OutFile $self
  }
  Step "re-launching under PowerShell 7 ($pwsh)"
  & $pwsh -NoProfile -ExecutionPolicy Bypass -File $self
  return
}

# 3. Cloud modules (Graph, EXO) — BEST EFFORT, each installed only if missing. A blocked/failed
# install must NOT abort: the runner loads each module only if present, so a missing one just means
# those jobs skip (AD works without them), and the runner self-heals any other Microsoft.Graph.*
# a job turns out to need. Targeted Graph submodules (what the executors actually call) instead of
# the 40-module Microsoft.Graph meta package: minutes faster, fewer assembly-version conflicts.
Step "installing cloud modules (best-effort; only the missing ones)"
try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -ErrorAction SilentlyContinue | Out-Null } catch {}
if (-not (Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue)) { Register-PSRepository -Default -ErrorAction SilentlyContinue }
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
$mods = @(
  'Microsoft.Graph.Authentication'
  'Microsoft.Graph.Users'
  'Microsoft.Graph.Users.Actions'
  'Microsoft.Graph.Groups'
  'Microsoft.Graph.Identity.SignIns'
  'Microsoft.Graph.Identity.DirectoryManagement'
  'ExchangeOnlineManagement'
)
foreach ($m in $mods) {
  if (Get-Module -ListAvailable -Name $m) { Write-Host "  $m already present" -ForegroundColor DarkGray; continue }
  Step "installing $m"
  try { Install-Module $m -Scope AllUsers -Force -AllowClobber -AcceptLicense -ErrorAction Stop }
  catch { Write-Warning "skipped $m (its jobs will be skipped): $($_.Exception.Message)" }
}
# Prove the critical one loads in THIS pwsh — the same runtime the runner's jobs use.
try { Import-Module Microsoft.Graph.Authentication -ErrorAction Stop; Step "verified: Microsoft.Graph.Authentication imports under pwsh 7" }
catch { Write-Warning "Microsoft.Graph.Authentication failed to import under pwsh 7: $($_.Exception.Message)" }
# On a domain controller the ActiveDirectory module is already present (AD DS role).
if ($NeedAd -and -not (Get-Module -ListAvailable -Name ActiveDirectory)) {
  try {
    $cap = Get-WindowsCapability -Online -Name 'Rsat.ActiveDirectory*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cap) { Add-WindowsCapability -Online -Name $cap.Name } else { Write-Warning "ActiveDirectory module not found — install RSAT or run on a domain-joined host." }
  } catch { Write-Warning "could not add the ActiveDirectory module: $($_.Exception.Message)" }
}

# ngrok-skip-browser-warning bypasses ngrok-free's HTML interstitial (harmless on other hosts).
$H = @{ 'ngrok-skip-browser-warning' = 'true' }

# 4. Download the runner (manifest + per-file)
Step "downloading runner -> $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H
foreach ($rel in $manifest.files) {
  $dest = Join-Path $InstallDir ($rel -replace '/', '\\')
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  $body = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H
  [System.IO.File]::WriteAllText($dest, $body.Content)
}

# 5. Auto-enroll (token -> agent id; the token carries scope + client)
Step "enrolling agent"
$enroll = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/agents" -ContentType 'application/json' -Headers $H -Body (@{ name = "${agentName}"; enrollToken = $Token } | ConvertTo-Json)
$AgentId = $enroll.id
if (-not $AgentId) { Write-Error "Enrollment failed (no agent id returned)."; return }
Write-Host "  enrolled: $AgentId" -ForegroundColor Green

# 5b. Bearer token (Machine env) so the SYSTEM task authenticates to the app once it fails-closed.
# Not put on the task command line, so it isn't visible in the task definition.
if ($ApiToken) {
  [Environment]::SetEnvironmentVariable('RUNNER_API_TOKEN', $ApiToken, 'Machine')
  Write-Host "  set RUNNER_API_TOKEN (Machine env)" -ForegroundColor Green
}

# 6. Register + start a Scheduled Task (at startup, restart on failure)
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
  return ps(script, download);
}
