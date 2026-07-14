#Requires -Version 7.0
<#
.SYNOPSIS
    iam-engine runner. Polls the app, claims jobs, executes via Coretelligent.* modules,
    posts results. Same script runs as the central cloud runner or a client-network agent.
.NOTES
    Outbound HTTPS only. Authenticates with mTLS in production (omitted in this skeleton).
    See docs/RUNNER_PROTOCOL.md.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppUrl,        # https://iam-engine.internal
    [Parameter(Mandatory)][string]$AgentId,
    [string]$ApiToken = $env:RUNNER_API_TOKEN,    # interim shared bearer (until mTLS)
    [int]$PollSeconds = 5,
    [int]$BatchSize   = 5,
    # ExchangeOnlineManagement 3.10.0's REST cmdlets break on PowerShell 7.6 ("[HttpResponseMessage]
    # does not contain a method named 'GetResponseHeader'"); 3.9.2 is the known-good build. Pin the
    # version the runner loads so it never auto-picks a broken one. Override per host if needed.
    [string]$ExoModuleVersion = '3.9.2',
    # Watchdog: restart the process if it makes no progress for this long (a hung inline job — the
    # only failure the loop can't self-heal). Default 600s; aligns with the app's 10-min stale-lease
    # reclaim so the orphaned job re-queues just as the fresh process comes up. Env: RUNNER_STALL_TIMEOUT.
    [int]$StallTimeoutSeconds = 600,
    # Heartbeat file the watchdog + -HealthCheck read; defaults to a temp path keyed by AgentId
    # (kept out of the bundle so it can't affect the build hash). Env: RUNNER_HEARTBEAT_FILE.
    [string]$HeartbeatFile = '',
    # Liveness-probe mode: report health from the heartbeat file and exit (0 healthy / 1 stale) WITHOUT
    # starting the runner. Backs an Azure Container Apps `exec` liveness probe in managed hosting.
    [switch]$HealthCheck
)

# The watchdog is lightweight and the -HealthCheck probe must be fast, so load it + resolve the
# heartbeat path BEFORE the heavy automation modules. A health probe never loads the rest.
Import-Module "$PSScriptRoot/lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1" -Force
if (-not $PSBoundParameters.ContainsKey('StallTimeoutSeconds') -and $env:RUNNER_STALL_TIMEOUT) { $StallTimeoutSeconds = [int]$env:RUNNER_STALL_TIMEOUT }
$HeartbeatFile = Get-CtgHeartbeatPath -Explicit $HeartbeatFile -AgentId $AgentId
if ($HealthCheck) {
    $h = Test-CtgRunnerHealth -Path $HeartbeatFile -TimeoutSeconds $StallTimeoutSeconds
    if (-not $h.healthy) { Write-Error "runner unhealthy: $($h.reason)"; exit 1 }
    Write-Host "runner healthy: $($h.reason)"
    exit 0
}
$global:CtgHeartbeatFile = $HeartbeatFile

$ErrorActionPreference = 'Stop'
# This is a non-interactive background service. Suppress progress bars + ANSI cursor control: writing
# a progress bar / colored output to a redirected or detached stdout (notably right after a self-update
# relaunch, when the old console is gone) throws "Out-LineOutput: Input/output error" and leaks
# cursor-position reports (the ;1R noise) into the log. PlainText output avoids the escape sequences.
$ProgressPreference = 'SilentlyContinue'
try { if (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'PlainText' } } catch { }

# Non-interactive PSGallery bootstrap shared by the Graph skew guard below and the missing-module
# self-heal further down. The runner is detached (no stdin) — nothing here may ever prompt.
function Initialize-CtgGallery {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    }
    if ((Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue).InstallationPolicy -ne 'Trusted') {
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    }
}

# --- Microsoft.Graph version-skew guard ---------------------------------------------------------
# Graph submodules only load together when every resolved submodule carries the SAME version:
# mixing (say) Authentication 2.33 with Users 2.38 dies at Import-Module with "Assembly with same
# name is already loaded" — killing the runner before it ever polls (seen on the Six One DC agent).
# Skew accumulates because installs land in different scopes over time (the SYSTEM task's
# CurrentUser profile vs AllUsers). PowerShell resolves the HIGHEST version per submodule across
# PSModulePath, so repair = install the set's max version for every lagging submodule. No deletes:
# old copies may be file-locked by another process, and a higher version simply wins resolution.
function Repair-CtgGraphVersionSkew {
    $avail = Get-Module -ListAvailable -Name 'Microsoft.Graph.*' -ErrorAction SilentlyContinue
    if (-not $avail) { return }
    $resolved = $avail | Group-Object Name | ForEach-Object { ($_.Group | Sort-Object Version -Descending)[0] }
    $versions = @($resolved | ForEach-Object Version | Sort-Object -Unique)
    if ($versions.Count -le 1) { return }
    $target = ($versions | Sort-Object -Descending)[0]
    $lagging = @($resolved | Where-Object { $_.Version -ne $target })
    Write-Warning ("Microsoft.Graph submodule versions are mixed ({0}) — aligning {1} module(s) to {2}" -f ($versions -join ', '), $lagging.Count, $target)
    Initialize-CtgGallery
    foreach ($m in $lagging) {
        try {
            Install-Module $m.Name -RequiredVersion $target -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop
            Write-Host "  aligned $($m.Name) $($m.Version) -> $target" -ForegroundColor Yellow
        } catch {
            Write-Warning "  could not align $($m.Name) to ${target}: $($_.Exception.Message)"
        }
    }
}
Repair-CtgGraphVersionSkew

Import-Module "$PSScriptRoot/modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Zoom/Coretelligent.Zoom.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Adobe/Coretelligent.Adobe.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Perimeter81/Coretelligent.Perimeter81.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Spanning/Coretelligent.Spanning.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.1Password/Coretelligent.1Password.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Egnyte/Coretelligent.Egnyte.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Salesforce/Coretelligent.Salesforce.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.KnowBe4/Coretelligent.KnowBe4.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Jira/Coretelligent.Jira.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.HubSpot/Coretelligent.HubSpot.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.SentinelOne/Coretelligent.SentinelOne.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Duo/Coretelligent.Duo.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.XMatters/Coretelligent.XMatters.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.LogicMonitor/Coretelligent.LogicMonitor.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Notify/Coretelligent.Notify.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Proofpoint/Coretelligent.Proofpoint.psd1" -Force
# Browser-automation bridge (shells out to the Node/Playwright sidecar in runner/browser). Loads
# unconditionally — Test-CtgBrowserAvailable reports whether Node+Playwright are actually installed,
# and the app's claim gate withholds browser jobs (e.g. spanning-force-sync) from agents that can't run them.
Import-Module "$PSScriptRoot/modules/Coretelligent.Browser/Coretelligent.Browser.psd1" -Force
# (Coretelligent.Secrets is no longer imported: the app now resolves the secret value and pushes it
# down in the credential response — the runner no longer talks to Delinea itself.)
# These modules depend on host-specific cmdlets: the AD module needs the on-prem ActiveDirectory
# module (client-network agent only); Exchange needs ExchangeOnlineManagement. Load each only
# where its dependency is present so the central cloud runner doesn't fail to import.
#
# Loading ActiveDirectory on a DC is subtle. It's a Windows PowerShell module, and pwsh 7 (what the
# runner runs) frequently CANNOT see it via Get-Module -ListAvailable — RSAT installs it off pwsh 7's
# PSModulePath, so only Windows PowerShell 5.1 enumerates it (verified on 61C-DC01: -ListAvailable blank
# in pwsh 7, but 5.1 has it and Import-Module ActiveDirectory -UseWindowsPowerShell works). pwsh 7 loads
# it through the Windows-compat proxy: a background 5.1 session that proxies the AD cmdlets. So try native
# in-proc first (fastest, when pwsh 7 can see it), then the compat proxy, and only self-heal-install RSAT
# when it's genuinely absent from BOTH. Whatever loads it, Coretelligent.ActiveDirectory's RequiredModules
# is then satisfied by the already-loaded 'ActiveDirectory' module (name match — no native re-resolve).
function Import-CtgActiveDirectory {
    if (Get-Command Get-ADUser -ErrorAction SilentlyContinue) { return $true }  # already loaded this process
    if (Get-Module -ListAvailable ActiveDirectory) {
        try { Import-Module ActiveDirectory -Force -ErrorAction Stop; return $true } catch { }
    }
    if ($IsWindows) {
        # Windows-compat proxy — the path that works on a DC where RSAT is visible only to WinPS 5.1.
        try { Import-Module ActiveDirectory -UseWindowsPowerShell -WarningAction SilentlyContinue -ErrorAction Stop; return $true } catch { }
    }
    return $false
}
$adReady = Import-CtgActiveDirectory
if (-not $adReady -and $IsWindows) {
    # Not loadable natively OR via the compat proxy -> RSAT is genuinely absent. Self-heal: add it ONCE
    # (best-effort; needs elevation + Windows Update), then retry the load. Quiet where it doesn't apply.
    try {
        $adCap = Get-WindowsCapability -Online -Name 'Rsat.ActiveDirectory.DS-LDS.Tools*' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($adCap -and $adCap.State -ne 'Installed') {
            Write-Host "ActiveDirectory module missing — installing RSAT capability ($($adCap.Name))…" -ForegroundColor Yellow
            Add-WindowsCapability -Online -Name $adCap.Name -ErrorAction Stop | Out-Null
        } elseif (-not $adCap -and (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue)) {
            # A server with the ServerManager module (e.g. a DC) exposes RSAT-AD-PowerShell as a feature.
            Write-Host "ActiveDirectory module missing — installing RSAT-AD-PowerShell feature…" -ForegroundColor Yellow
            Install-WindowsFeature RSAT-AD-PowerShell -ErrorAction Stop | Out-Null
        }
        $adReady = Import-CtgActiveDirectory
    } catch { Write-Warning "could not auto-install the ActiveDirectory RSAT module (install RSAT-AD-PowerShell manually + restart the runner): $($_.Exception.Message)" }
}
if ($adReady) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
} else {
    Write-Warning "ActiveDirectory module could not be loaded on this host — AD jobs will be withheld (this agent reports no 'active-directory' capability)."
}
$exoAvail = Get-Module -ListAvailable ExchangeOnlineManagement
if ($exoAvail) {
    # Load the pinned EXO version FIRST (before Coretelligent.Exchange's RequiredModules auto-picks the
    # highest) so a broken build (3.10.0 on PS7.6) is never the one in scope. Fall back to the newest
    # available if the pin isn't installed — with a warning, since that may be the broken one.
    $exoPick = $exoAvail | Where-Object { $_.Version -eq [version]$ExoModuleVersion } | Select-Object -First 1
    if ($exoPick) {
        Import-Module ExchangeOnlineManagement -RequiredVersion $ExoModuleVersion -Force
    } else {
        $newest = ($exoAvail | Sort-Object Version -Descending | Select-Object -First 1).Version
        Write-Warning "ExchangeOnlineManagement $ExoModuleVersion not installed; using $newest (install the pin if EXO cmdlets fail with 'GetResponseHeader')."
        Import-Module ExchangeOnlineManagement -RequiredVersion $newest -Force
    }
    Import-Module "$PSScriptRoot/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
}

# Safe property/key read at the RUNNER scope. Each Coretelligent module has its own private copy of
# this helper, but those aren't exported — so a script-scope call (e.g. reading $job.config) must use
# this one. Without it, the call is an unresolved command that the dependency guard below mistakes for
# a missing host-specific module ("the Coretelligent module providing 'Get-CtgProp' isn't loaded…").
function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Persistent troubleshooting log: errors/warnings/failures append to runner.log next to the
# script (build-id + bundle walks skip *.log), rotating at 5 MB. Pull a line from here when
# reporting an issue — it has the timestamp, job id and full error the console may have scrolled.
$script:CtgLogPath = Join-Path $PSScriptRoot 'runner.log'
function Write-CtgLog {
    param([ValidateSet('ERROR', 'WARN', 'INFO')][string]$Level = 'INFO', [Parameter(Mandatory)][string]$Message)
    try {
        if ((Test-Path $script:CtgLogPath) -and (Get-Item $script:CtgLogPath).Length -gt 5MB) {
            Move-Item $script:CtgLogPath "$($script:CtgLogPath).1" -Force
        }
        Add-Content -Path $script:CtgLogPath -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) [$Level] $Message"
    } catch { }  # logging must never break the runner
}

# Build the AD connection splat from the brokered ad-dc secret (Option 2): the AD module
# authenticates as the ad-dc account (-Credential) against the DC named in its Fields (-Server),
# so the runner's own process identity needs no AD rights. Empty when ad-dc isn't brokered (the
# central runner / a host already running as a domain account).
function New-CtgAdConnection($creds) {
    $ad = @{}
    $s = $creds['ad-dc']
    if ($s) {
        if ($s.Credential) { $ad.Credential = $s.Credential }
        # DC to target (-Server). The "Active Directory Account" Delinea template has no Server
        # field, so the DC name is stored in its "Documentation Link" field — accept that (and a few
        # aliases). Ignore a value that looks like a URL (a genuine doc link) so it can't be mistaken
        # for a server. Omit entirely when the agent is on the DC (cmdlets use the local domain).
        $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return [string]$s.Fields[$k] } } $null }
        $server = & $pick @('Server', 'DomainController')
        if (-not $server) {
            $docLink = & $pick @('Documentation Link', 'DocumentationLink', 'Document Link', 'DocLink')
            if ($docLink -and $docLink -notmatch '^\s*https?://') { $server = $docLink }
        }
        if ($server) { $ad.Server = ([string]$server).Trim() }
    }
    return $ad
}

# Point the Spanning module at this job's brokered secret. The verified API authenticates with
# Basic clientId:clientSecret against o365-api-{region}.spanningbackup.com/external — so with the
# "Automation - API" template, ClientID is the Basic USERNAME and ClientSecret the password. Legacy
# tenants (domain:access-token) still work: Domain/AccountID, or the client's primary domain, fill
# the username slot when no ClientID is present. Reads PLAIN values from .Fields (.Password is a
# SecureString). Called at the START OF EVERY spanning lane (not a cached Connect) so a rotated
# credential takes effect on the next job, no restart needed.
function Use-CtgSpanningSecret {
    param($Job, $Creds)
    $s = $Creds['spanning']
    if (-not $s) { throw "the job did not broker a 'spanning' secret — make sure the client's spanning system lists 'spanning' in its secrets" }
    $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
    $tokenNames = @('ClientSecret', 'AccessToken', 'Access Token', 'ApiToken', 'API Key', 'APIKey', 'Api Key', 'ApiKey', 'Token', 'Key', 'Password')
    $token = & $pick $tokenNames
    # Fail actionably, not with an opaque parameter-binding error: name the fields we looked
    # for AND the ones the secret actually has, so the fix (rename a Delinea field) is obvious.
    if (-not $token) { throw "the 'spanning' secret has no client-secret/token field — looked for $($tokenNames -join ', '); the secret has: $(@($s.Fields.Keys) -join ', '). Put the Spanning client secret in one of those fields (see /help/spanning)." }
    $user = & $pick @('ClientID', 'ClientId', 'Client ID', 'Domain', 'AccountID', 'AccountId', 'Account', 'Tenant')
    if (-not $user) { $user = if ($s.Username) { $s.Username } else { $Job.client.primaryDomain } }
    $baseUrl = & $pick @('apiURL', 'ApiUrl', 'ApiURL', 'BaseUrl', 'Url')
    if ($baseUrl) { Connect-CtgSpanning -Username $user -AccessToken $token -BaseUrl $baseUrl }
    else          { Connect-CtgSpanning -Username $user -AccessToken $token -Region $s.Fields['Region'] }
}

# Point the Proofpoint module at this job's brokered secret. Proofpoint Essentials authenticates with
# the admin email + password as X-User / X-Password headers (admin accounts only). The org domain for
# the /orgs/{domain} path comes from a Domain field, else the client's primary domain. Region/BaseUrl
# select the tenant's pod (us1..us5/eu1/au1). Reads PLAIN field values (.Password is also a SecureString,
# but the API needs the cleartext header). Called at the start of every proofpoint lane (no cached Connect).
function Use-CtgProofpointSecret {
    param($Job, $Creds)
    $s = $Creds['proofpoint']
    if (-not $s) { throw "the job did not broker a 'proofpoint' secret — make sure the client's proofpoint system lists 'proofpoint' in its secrets" }
    $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
    $user = & $pick @('X-User', 'Username', 'AdminUser', 'Admin', 'Email', 'User')
    if (-not $user) { $user = $s.Username }
    if (-not $user) { throw "the 'proofpoint' secret has no admin-email field — looked for X-User, Username, AdminUser, Email; the secret has: $(@($s.Fields.Keys) -join ', '). Put the Proofpoint admin email in one of those." }
    $pass = & $pick @('X-Password', 'Password', 'AdminPassword', 'Secret', 'ApiKey', 'API Key', 'Token')
    if (-not $pass) { throw "the 'proofpoint' secret has no admin-password field — looked for X-Password, Password, AdminPassword; the secret has: $(@($s.Fields.Keys) -join ', '). Put the Proofpoint admin password in one of those." }
    $domain = & $pick @('Domain', 'OrgDomain', 'Org', 'Tenant')
    if (-not $domain) { $domain = $Job.client.primaryDomain }
    if (-not $domain) { throw "the 'proofpoint' secret has no Domain field and the client has no primary domain — Proofpoint needs the org domain for the /orgs/{domain} path." }
    $baseUrl = & $pick @('BaseUrl', 'ApiUrl', 'apiURL', 'Url')
    if ($baseUrl) { Connect-CtgProofpoint -User ([string]$user) -Password ([string]$pass) -Domain ([string]$domain) -BaseUrl $baseUrl }
    else {
        $region = & $pick @('Region', 'Pod')
        Connect-CtgProofpoint -User ([string]$user) -Password ([string]$pass) -Domain ([string]$domain) -Region ([string]($region ?? 'us1'))
    }
}

# Sign in to 1Password with the brokered admin account so `op` can provision/suspend users. Only the
# api/auto/scim methods need this; field-tolerant like the others. Returns $true on success. The CALLER
# decides whether a failure is fatal (api) or a fallback-to-manual signal (auto) — so this throws and
# the dispatch wraps it.
function Use-Ctg1PasswordSecret {
    param($Job, $Creds)
    $s = $Creds['1password']
    if (-not $s) { throw "the job did not broker a '1password' secret — list '1password' in the client's 1password system secrets (the api/scim methods need an admin sign-in). See /help/1password." }
    $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return [string]$s.Fields[$k] } } $null }
    $cfg = if ($Job.config) { $Job.config } else { [pscustomobject]@{} }
    $address = (& $pick @('SignInAddress', 'Sign In Address', 'Account', 'Url', 'apiURL', 'Domain'))
    if (-not $address) { $address = [string](Get-CtgProp $cfg 'signInAddress') }
    $email = (& $pick @('Email', 'Username', 'User', 'AdminEmail'))
    if (-not $email -and $s.Username) { $email = [string]$s.Username }
    $secretKey = (& $pick @('SecretKey', 'Secret Key', 'SecretKey ', 'Key'))
    $password = (& $pick @('Password', 'Pass'))
    foreach ($pair in @(@('sign-in address', $address), @('email', $email), @('Secret Key', $secretKey), @('password', $password))) {
        if (-not $pair[1]) { throw "the '1password' secret is missing $($pair[0]) — the api method needs SignInAddress + Email + SecretKey + Password (an admin/owner account, MFA-exempt). The secret has: $(@($s.Fields.Keys) -join ', '). See /help/1password." }
    }
    Connect-Ctg1Password -SignInAddress $address -Email $email -SecretKey $secretKey -Password $password
}

# Establish an `op` admin session for this job IF the method needs/wants one, returning $connected.
# api REQUIRES it (a failure throws); auto/scim treat it as best-effort (a failure -> $false, and the
# module falls back to a manual checklist / skips the optional verify); manual/browser never connect.
function Connect-Ctg1PasswordForJob {
    param($Job, $Creds)
    $method = ([string](Get-CtgProp $Job.config 'method')); if (-not $method) { $method = 'auto' }
    if ($method -in @('manual', 'browser')) { return $false }
    try { Use-Ctg1PasswordSecret -Job $Job -Creds $Creds; return $true }
    catch {
        if ($method -eq 'api') { throw }
        Set-CtgPhase $Job.id "1Password ($method): admin sign-in unavailable — $($_.Exception.Message)"
        return $false
    }
}

# Connect Google Workspace from the brokered 'google-admin' secret. Domain-wide-delegated SERVICE
# ACCOUNT: the secret carries the downloaded JSON key (whole, as ServiceAccountJson, or base64 as
# ServiceAccountKeyBase64 — Delinea-safe for the multi-line private_key) OR ClientEmail+PrivateKey
# split out; plus the super-admin to impersonate (Impersonate field, else the secret's Username).
# Connect-CtgGoogle mints a fresh OAuth token each call, so a rotated key takes effect next job. See
# /help/google for the Cloud/Workspace setup that produces these fields.
function Use-CtgGoogleSecret {
    param($Job, $Creds)
    $s = $Creds['google-admin']
    if (-not $s) { throw "the job did not broker a 'google-admin' secret — make sure the client's google-workspace system lists 'google-admin' in its secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $clientEmail = & $pick @('ClientEmail', 'ServiceAccountEmail', 'client_email')
    $privateKey  = & $pick @('PrivateKey', 'private_key')
    $json = & $pick @('ServiceAccountJson', 'ServiceAccountKeyJson', 'KeyJson')
    $b64  = & $pick @('ServiceAccountKeyBase64', 'ServiceAccountJsonBase64', 'KeyBase64')
    if ($b64 -and -not $json) { $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    if ($json) {
        $sa = $json | ConvertFrom-Json
        if (-not $clientEmail) { $clientEmail = [string]$sa.client_email }
        if (-not $privateKey)  { $privateKey  = [string]$sa.private_key }
    }
    if (-not $clientEmail -or -not $privateKey) {
        throw "the 'google-admin' secret has no service-account key — set ServiceAccountKeyBase64 (the downloaded JSON key, base64-encoded) or ServiceAccountJson, or split ClientEmail+PrivateKey. The secret has: $(@($f.Keys) -join ', '). See /help/google."
    }
    $impersonate = & $pick @('Impersonate', 'AdminEmail', 'Admin', 'Subject', 'DelegatedAdmin', 'AdminUser')
    if (-not $impersonate -and $s.Username) { $impersonate = [string]$s.Username }
    if (-not $impersonate) { throw "the 'google-admin' secret has no admin to impersonate — set the Impersonate field to a Workspace super-admin's email (domain-wide delegation acts as a real admin). See /help/google." }
    $customer = & $pick @('CustomerId', 'Customer'); if (-not $customer) { $customer = 'my_customer' }
    $scopesRaw = & $pick @('Scopes', 'Scope')
    $scopes = if ($scopesRaw) { @($scopesRaw -split '[,\s]+' | Where-Object { $_ }) } else { @() }
    if ($scopes.Count) { Connect-CtgGoogle -ClientEmail $clientEmail -PrivateKey $privateKey -Impersonate $impersonate -CustomerId $customer -Scopes $scopes }
    else               { Connect-CtgGoogle -ClientEmail $clientEmail -PrivateKey $privateKey -Impersonate $impersonate -CustomerId $customer }
}

# Connect Salesforce from the brokered 'salesforce' secret. Connected App JWT bearer: ConsumerKey
# (the app's client_id), the integration Username to act as, and the cert PrivateKey (PEM, or
# PrivateKeyBase64 — Delinea-safe). Sandbox tenants set LoginUrl/IsSandbox. Each lane re-connects so
# a rotated cert applies next job. See /help/salesforce.
function Use-CtgSalesforceSecret {
    param($Job, $Creds)
    $s = $Creds['salesforce']
    if (-not $s) { throw "the job did not broker a 'salesforce' secret — list 'salesforce' in the client's salesforce system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $consumerKey = & $pick @('ConsumerKey', 'ClientID', 'ClientId', 'ConsumerId')
    $username    = & $pick @('Username', 'IntegrationUser', 'AdminUser', 'Subject'); if (-not $username -and $s.Username) { $username = [string]$s.Username }
    $privateKey  = & $pick @('PrivateKey', 'private_key')
    $b64         = & $pick @('PrivateKeyBase64', 'CertificateBase64', 'KeyBase64')
    if ($b64 -and -not $privateKey) { $privateKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    if (-not $consumerKey -or -not $username -or -not $privateKey) {
        throw "the 'salesforce' secret needs ConsumerKey + Username + PrivateKey (or PrivateKeyBase64). The secret has: $(@($f.Keys) -join ', '). See /help/salesforce."
    }
    $loginUrl = & $pick @('LoginUrl', 'LoginURL', 'InstanceUrl')
    if (-not $loginUrl) { $loginUrl = if ((& $pick @('IsSandbox', 'Sandbox')) -match '^(true|1|yes)$') { 'https://test.salesforce.com' } else { 'https://login.salesforce.com' } }
    Connect-CtgSalesforce -ConsumerKey $consumerKey -Username $username -PrivateKey $privateKey -LoginUrl $loginUrl
}

# Connect KnowBe4 from the brokered 'knowbe4' secret — the SCIM bearer token (+ optional region BaseUrl).
function Use-CtgKnowBe4Secret {
    param($Job, $Creds)
    $s = $Creds['knowbe4']
    if (-not $s) { throw "the job did not broker a 'knowbe4' secret — list 'knowbe4' in the client's knowbe4 system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $token = & $pick @('ScimToken', 'SCIMToken', 'Token', 'ApiToken', 'Key', 'Password')
    if (-not $token) { throw "the 'knowbe4' secret has no SCIM token — set ScimToken (Account Settings > User Management > SCIM). The secret has: $(@($f.Keys) -join ', '). See /help/knowbe4." }
    $baseUrl = & $pick @('BaseUrl', 'ScimUrl', 'Url')
    if ($baseUrl) { Connect-CtgKnowBe4 -Token $token -BaseUrl $baseUrl } else { Connect-CtgKnowBe4 -Token $token }
}

# Connect Jira from the brokered 'jira' secret — Basic (admin email : API token) + the site URL.
function Use-CtgJiraSecret {
    param($Job, $Creds)
    $s = $Creds['jira']
    if (-not $s) { throw "the job did not broker a 'jira' secret — list 'jira' in the client's jira system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $email = & $pick @('Email', 'AdminEmail', 'Username'); if (-not $email -and $s.Username) { $email = [string]$s.Username }
    $token = & $pick @('ApiToken', 'Token', 'Key', 'Password')
    $site  = & $pick @('SiteUrl', 'Site', 'Url', 'BaseUrl')
    if (-not $email -or -not $token -or -not $site) { throw "the 'jira' secret needs Email + ApiToken + SiteUrl (https://<site>.atlassian.net). The secret has: $(@($f.Keys) -join ', '). See /help/jira." }
    Connect-CtgJira -Email $email -ApiToken $token -SiteUrl $site
}

# Connect HubSpot from the brokered 'hubspot' secret — a private-app access token (Bearer).
function Use-CtgHubSpotSecret {
    param($Job, $Creds)
    $s = $Creds['hubspot']
    if (-not $s) { throw "the job did not broker a 'hubspot' secret — list 'hubspot' in the client's hubspot system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $token = & $pick @('AccessToken', 'Token', 'PrivateAppToken', 'ApiKey', 'Key', 'Password')
    if (-not $token) { throw "the 'hubspot' secret has no access token — set AccessToken (a private-app token). The secret has: $(@($f.Keys) -join ', '). See /help/hubspot." }
    $baseUrl = & $pick @('BaseUrl', 'Url')
    if ($baseUrl) { Connect-CtgHubSpot -Token $token -BaseUrl $baseUrl } else { Connect-CtgHubSpot -Token $token }
}

# Connect SentinelOne from the brokered 'sentinelone' secret — the management console URL + an API
# token (service user). ApiToken auth. Re-broker each lane so a rotated token applies next job.
function Use-CtgSentinelOneSecret {
    param($Job, $Creds)
    $s = $Creds['sentinelone']
    if (-not $s) { throw "the job did not broker a 'sentinelone' secret — list 'sentinelone' in the client's sentinelone system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $baseUrl = & $pick @('BaseUrl', 'ConsoleUrl', 'MgmtUrl', 'ManagementUrl', 'Url', 'ApiUrl')
    if (-not $baseUrl) { throw "the 'sentinelone' secret has no console URL — set BaseUrl to the management console (e.g. https://usea1-partners.sentinelone.net). The secret has: $(@($f.Keys) -join ', '). See /help/sentinelone." }
    $token = & $pick @('ApiToken', 'Token', 'ApiKey', 'API Key', 'Key', 'Password')
    if (-not $token) { throw "the 'sentinelone' secret has no API token — set ApiToken (a service-user token). The secret has: $(@($f.Keys) -join ', '). See /help/sentinelone." }
    Connect-CtgSentinelOne -BaseUrl $baseUrl -Token $token
}

# The machine names the SentinelOne offboard should isolate = the user's Entra-registered devices,
# resolved via the brokered 'm365-admin' app (the same single source the M365 step captures). Returns
# @() when m365-admin isn't brokered or nothing resolves — the S1 module then falls back to the
# config/payload machineName. Best-effort: a Graph hiccup logs a note and falls back, never blocks the
# isolate. (Connects Graph here on the m365-admin app; harmless alongside the S1 connection.)
function Get-CtgSentinelOneMachines {
    param($Job, $Creds)
    if (-not $Creds['m365-admin']) { return @() }
    try {
        Connect-CtgM365 -Credential $Creds['m365-admin'].Credential -TenantId (Get-CtgTenantDomain $Job $Creds)
        $upn = Resolve-CtgM365Upn -User $Job.payload
        if (-not $upn) { return @() }
        @(Get-CtgM365UserDevices -UserId $upn | ForEach-Object { [string]$_.DisplayName } | Where-Object { $_ })
    } catch {
        Send-CtgProgress "could not resolve Entra devices for SentinelOne ($($_.Exception.Message)) — falling back to the configured machine name"
        @()
    }
}

# Connect Duo from the brokered 'duo' secret — the Admin API host + integration key + secret key.
function Use-CtgDuoSecret {
    param($Job, $Creds)
    $s = $Creds['duo']
    if (-not $s) { throw "the job did not broker a 'duo' secret — list 'duo' in the client's duo system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $apiHost = & $pick @('ApiHost', 'Host', 'Hostname', 'ApiHostname', 'BaseUrl', 'Url')
    $ikey    = & $pick @('IntegrationKey', 'IKey', 'ClientID', 'ClientId', 'Username'); if (-not $ikey -and $s.Username) { $ikey = [string]$s.Username }
    $skey    = & $pick @('SecretKey', 'SKey', 'ClientSecret', 'Secret', 'ApiKey', 'Key', 'Password')
    if (-not $apiHost -or -not $ikey -or -not $skey) { throw "the 'duo' secret needs ApiHost (api-XXXX.duosecurity.com) + IntegrationKey + SecretKey from a Duo Admin API application. The secret has: $(@($f.Keys) -join ', '). See /help/duo." }
    Connect-CtgDuo -ApiHost $apiHost -IntegrationKey $ikey -SecretKey $skey
}

# Connect xMatters from the brokered 'xmatters' secret — the company URL + a REST web-service user
# (Basic). The credential is the secret's pscredential, or Username/Password fields.
function Use-CtgXMattersSecret {
    param($Job, $Creds)
    $s = $Creds['xmatters']
    if (-not $s) { throw "the job did not broker an 'xmatters' secret — list 'xmatters' in the client's xmatters system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $baseUrl = & $pick @('apiURL', 'ApiUrl', 'BaseUrl', 'CompanyUrl', 'Url', 'Instance')
    if (-not $baseUrl) { throw "the 'xmatters' secret has no company URL — set apiURL (https://{company}.xmatters.com). The secret has: $(@($f.Keys) -join ', '). See /help/xmatters." }
    # xMatters API KEY + SECRET as Basic auth (key = username, secret = password). The Delinea
    # "Automation API" template stores them as clientID + ClientSecret; a REST user's Username +
    # Password works too. Prefer explicit fields, else the stored credential. (accountId is unused.)
    $u = & $pick @('ClientID', 'ClientId', 'ApiKey', 'AccessKey', 'Key', 'Username', 'User')
    $p = & $pick @('ClientSecret', 'Secret', 'ApiSecret', 'Password', 'Token', 'ApiToken')
    if (-not $u -and $s.Credential -and $s.Credential.UserName) { $u = [string]$s.Credential.UserName }
    if (-not $u -and $s.Username) { $u = [string]$s.Username }
    if (-not $p -and $s.Credential -and $s.Credential.Password) { $p = ConvertFrom-SecureString $s.Credential.Password -AsPlainText }
    if (-not $u -or -not $p) { throw "the 'xmatters' secret needs an API key + secret (clientID/ClientSecret) or a REST user Username + Password. The secret has: $(@($f.Keys) -join ', '). See /help/xmatters." }
    $cred = [pscredential]::new(([string]$u).Trim(), (ConvertTo-SecureString (([string]$p).Trim()) -AsPlainText -Force))
    Connect-CtgXMatters -BaseUrl $baseUrl -Credential $cred
}

# Connect LogicMonitor from the brokered 'logicmonitor' secret — the portal account + LMv1 access id +
# access key (an API-token, not a user password).
function Use-CtgLogicMonitorSecret {
    param($Job, $Creds)
    $s = $Creds['logicmonitor']
    if (-not $s) { throw "the job did not broker a 'logicmonitor' secret — list 'logicmonitor' in the client's logicmonitor system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $account = & $pick @('Account', 'Portal', 'Company', 'Subdomain', 'BaseUrl', 'Url')
    if (-not $account) { throw "the 'logicmonitor' secret has no Account — set Account to the portal subdomain (e.g. 'coretelligent'). The secret has: $(@($f.Keys) -join ', '). See /help/logicmonitor." }
    $accessId  = & $pick @('AccessId', 'AccessID', 'ClientID', 'ClientId', 'Username'); if (-not $accessId -and $s.Username) { $accessId = [string]$s.Username }
    $accessKey = & $pick @('AccessKey', 'ClientSecret', 'Secret', 'ApiKey', 'Key', 'Password')
    if (-not $accessId -or -not $accessKey) { throw "the 'logicmonitor' secret needs AccessId + AccessKey (an LMv1 API token from Settings > User Access > API Tokens). The secret has: $(@($f.Keys) -join ', '). See /help/logicmonitor." }
    Connect-CtgLogicMonitor -Account $account -AccessId $accessId -AccessKey $accessKey
}

# Connect Zoom from the brokered 'zoom' secret — a Server-to-Server OAuth app: Client ID (the
# credential's username, or a Client* field), Client Secret (the password / *Secret field), and the
# Account ID. Tolerant of field-name variants and fails actionably (names what it looked for + what
# the secret has) instead of an opaque parameter-bind error.
function Use-CtgZoomSecret {
    param($Job, $Creds)
    $s = $Creds['zoom']
    if (-not $s) { throw "the job did not broker a 'zoom' secret — list 'zoom' in the client's zoom system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    # Accept the S2S app creds from EITHER explicit custom fields OR the secret's username/password —
    # whichever is set. Prefer a non-empty custom field, then fall back to the credential, so an
    # operator who put the Client ID in the Username slot AND one who used a ClientId field both work.
    $accountId    = & $pick @('AccountId', 'AccountID', 'Account ID', 'Account')
    $clientId     = & $pick @('ClientId', 'ClientID', 'Client ID')
    $clientSecret = & $pick @('ClientSecret', 'Client Secret', 'Secret', 'ApiKey', 'Key')
    if (-not $clientId -and $s.Credential -and $s.Credential.UserName) { $clientId = [string]$s.Credential.UserName }
    if (-not $clientId -and $s.Username) { $clientId = [string]$s.Username }
    if (-not $clientSecret -and $s.Credential -and $s.Credential.Password) { $clientSecret = ConvertFrom-SecureString $s.Credential.Password -AsPlainText }
    if (-not $clientSecret) { $clientSecret = & $pick @('Password') }
    # Trim copy-paste whitespace/newlines — a trailing space in the id/secret is a common cause of
    # Zoom's invalid_client (the value "looks right" but the Basic header carries the stray char).
    $accountId = ([string]$accountId).Trim(); $clientId = ([string]$clientId).Trim(); $clientSecret = ([string]$clientSecret).Trim()
    if (-not $accountId -or -not $clientId -or -not $clientSecret) { throw "the 'zoom' secret needs a Server-to-Server OAuth app — Username = Client ID, Password = Client Secret, plus an AccountId field (or ClientId/ClientSecret/AccountId custom fields). The secret has: $(@($f.Keys) -join ', '). See /help/zoom." }
    $cred = [pscredential]::new($clientId, (ConvertTo-SecureString $clientSecret -AsPlainText -Force))
    Connect-CtgZoom -Credential $cred -AccountId $accountId
}

# The M365/Exchange tenant identifier for this job, in priority order:
#   1. the m365-admin secret's TenantId field — the Directory (tenant) ID GUID from the app
#      registration; unambiguous and ALWAYS accepted by Entra, even when domain names are mis-set
#   2. the client's primary domain (set on the client page)
#   3. the m365-admin secret's Domain field (the cloud-auth guide's table includes it)
# A newly added client can have all three blank — without this guard that surfaced as the opaque
# "Cannot bind argument to parameter 'TenantId' because it is an empty string".
function Get-CtgTenantDomain {
    param($Job, $Creds)
    $s = $Creds['m365-admin']
    $t = if ($s -and $s.Fields['TenantId']) { $s.Fields['TenantId'] }
         elseif ($Job.client.primaryDomain) { $Job.client.primaryDomain }
         elseif ($s) { $s.Fields['Domain'] }
    if (-not $t) {
        $have = if ($s) { @($s.Fields.Keys) -join ', ' } else { 'no m365-admin secret brokered' }
        throw "no tenant for client '$($Job.client.slug)': client.primaryDomain is empty and the m365-admin secret has no TenantId/Domain field (its fields: $have). Best fix: put the Directory (tenant) ID from the app registration in a TenantId field on the secret, or set the client's primary domain (see /help/cloud-auth)."
    }
    $t
}

function Get-CtgExoOrganization {
    # Exchange Online's -Organization needs a DOMAIN (e.g. dcg.co / dcg.onmicrosoft.com), NOT the
    # tenant GUID that Graph -TenantId uses ("Organization cannot be a Guid").
    #
    # CRITICAL: EXO must operate on the SAME tenant the user was just created in via Graph. Graph
    # connects with the authoritative TenantId (a GUID); deriving EXO's domain independently from the
    # client's primaryDomain can resolve to a DIFFERENT directory (e.g. JAMS' primaryDomain newcoinc.com
    # resolved to a separate "Newco, Inc." tenant while Graph used the real app tenant) → AADSTS700016
    # "app not found in directory". So PREFER the connected Graph tenant's own default verified domain;
    # only fall back to client/secret/UPN domains when no Graph session is established.
    param($Job, $Creds)
    try {
        $org = @(Get-MgOrganization -ErrorAction Stop)[0]
        if ($org -and $org.VerifiedDomains) {
            $def = @($org.VerifiedDomains | Where-Object { $_.IsDefault } | ForEach-Object { [string]$_.Name } | Where-Object { $_ })
            if ($def.Count) { return $def[0] }
            $any = @($org.VerifiedDomains | ForEach-Object { [string]$_.Name } | Where-Object { $_ -and $_ -match '\.' })
            if ($any.Count) { return $any[0] }
        }
    }
    catch { } # no Graph session (e.g. a standalone exchange test) — fall back to configured domains
    $cand = [System.Collections.Generic.List[string]]::new()
    if ($Job.client -and $Job.client.primaryDomain) { $cand.Add([string]$Job.client.primaryDomain) }
    $s = $Creds['m365-admin']
    if ($s -and $s.Fields) { foreach ($k in @('Domain', 'TenantDomain', 'Organization')) { if ($s.Fields[$k]) { $cand.Add([string]$s.Fields[$k]) } } }
    if ($Job.payload -and $Job.payload.UserPrincipalName -and ([string]$Job.payload.UserPrincipalName) -match '@') { $cand.Add(([string]$Job.payload.UserPrincipalName -split '@')[1]) }
    foreach ($c in $cand) { $d = ([string]$c).Trim(); if ($d -and $d -notmatch '^[0-9a-fA-F-]{36}$') { return $d } }
    throw "no Exchange Online organization DOMAIN for '$($Job.client.slug)' — EXO needs a domain (e.g. <tenant>.onmicrosoft.com), not the tenant GUID. Set the client's primary domain, or add a Domain field to the m365-admin secret."
}

# systemKey -> { Connect?; Onboard; Offboard }. Connect (optional) runs once per tenant before
# the first job for that system; the action lanes receive ($job, $creds) where $creds maps each
# The initial password for a new user, in priority order:
#   1. A brokered Delinea secret — named by config.initialPasswordSecret, else a 'default-password'
#      secret if one was brokered (the app resolved + pushed it down like any credential).
#   2. A literal config.initialPassword (a default typed into the KB).
#   3. A generated policy-compliant password (the default).
# Always returns a SecureString. No StrictMode at runner scope, so missing config props read $null.
function Resolve-CtgInitialPassword {
    param($Job, $Creds)
    $cfg = $Job.config
    $secretName = if ($cfg) { [string]$cfg.initialPasswordSecret } else { $null }
    if ([string]::IsNullOrWhiteSpace($secretName) -and $Creds -and $Creds.ContainsKey('default-password')) { $secretName = 'default-password' }
    if (-not [string]::IsNullOrWhiteSpace($secretName) -and $Creds -and $Creds.ContainsKey($secretName) -and $Creds[$secretName]) {
        $s = $Creds[$secretName]
        $val = $null
        if ($s.Password) { $val = ConvertFrom-SecureString $s.Password -AsPlainText }
        if ([string]::IsNullOrWhiteSpace($val) -and $s.Fields) {
            foreach ($k in @('Password', 'InitialPassword', 'Value', 'Key', 'Secret')) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { $val = [string]$s.Fields[$k]; break } }
        }
        if (-not [string]::IsNullOrWhiteSpace($val)) { return (ConvertTo-SecureString $val -AsPlainText -Force) }
    }
    $literal = if ($cfg) { [string]$cfg.initialPassword } else { $null }
    if (-not [string]::IsNullOrWhiteSpace($literal)) { return (ConvertTo-SecureString $literal -AsPlainText -Force) }
    return (New-CtgCompliantPassword)
}

# Build the app-only Exchange Online cert args from a brokered secret's Fields — prefer a base64 PFX
# (cross-platform: macOS/Linux/Windows), else a Windows cert-store thumbprint. Empty when neither set.
function Get-CtgExoCertArgs {
    param($Secret)
    $a = @{}
    $f = if ($Secret) { $Secret.Fields } else { $null }
    if ($f) {
        $b64 = if ($f['CertificateBase64']) { $f['CertificateBase64'] } elseif ($f['CertificatePfxBase64']) { $f['CertificatePfxBase64'] } else { $null }
        if ($b64) {
            $a['CertificateBase64'] = [string]$b64
            if ($f['CertificatePassword']) { $a['CertificatePassword'] = [string]$f['CertificatePassword'] }
        }
        elseif ($f['CertificateThumbprint']) { $a['CertificateThumbprint'] = [string]$f['CertificateThumbprint'] }
    }
    $a
}

function Invoke-CtgM365ExoFinish {
    # Finish the m365 onboard over Exchange Online with the SAME m365-admin app cert (no separate
    # Exchange system): (1) add the distribution / mail-enabled groups Graph couldn't write; and when
    # MIRRORING, (2) copy the mirror user's cloud DLs and (3) their SHARED-MAILBOX permissions
    # (FullAccess / SendAs / SendOnBehalf) — the part Graph can't do. One EXO connection for all of it.
    # Idempotent + best-effort; returns action lines.
    param($Job, $Creds, [string[]]$Names, [string]$MirrorUser)
    $out = [System.Collections.Generic.List[string]]::new()
    $names = @($Names | Where-Object { $_ })
    $mirror = if ([string]::IsNullOrWhiteSpace($MirrorUser)) { $null } else { [string]$MirrorUser }
    if ($names.Count -eq 0 -and -not $mirror) { return $out.ToArray() }

    if (-not (Get-Command Invoke-CtgExchangeNamedGroups -ErrorAction SilentlyContinue)) {
        if ($names.Count) { $out.Add("note: $($names.Count) distribution list(s) not added — ExchangeOnlineManagement isn't installed on this runner, so the Coretelligent.Exchange module didn't load. Install it (or run this client on a runner that has it).") }
        if ($mirror) { $out.Add("note: shared mailboxes / DLs not mirrored — ExchangeOnlineManagement isn't installed on this runner.") }
        return $out.ToArray()
    }
    $s = $Creds['m365-admin']
    $certArgs = Get-CtgExoCertArgs $s
    if ($certArgs.Count -eq 0) {
        $out.Add("note: Exchange Online steps skipped — the m365-admin secret has no EXO cert: set CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows), and grant the app Exchange.ManageAsApp.")
        return $out.ToArray()
    }
    try {
        $what = @($(if ($names.Count) { 'distribution lists' }), $(if ($mirror) { 'mirror (DLs + shared mailboxes)' }) | Where-Object { $_ }) -join ' + '
        $exoOrg = Get-CtgExoOrganization $Job $Creds
        Set-CtgPhase $Job.id "finishing over Exchange Online (app-only) for $exoOrg`: $what"
        Connect-CtgExchange -AppId $s.Credential.UserName -Organization $exoOrg @certArgs
        $upn = [string]$Job.payload.UserPrincipalName
        if ($names.Count) { foreach ($a in (Invoke-CtgExchangeNamedGroups -NewUser $upn -Groups $names)) { $out.Add($a) } }
        if ($mirror) {
            foreach ($a in (Invoke-CtgExchangeDistListMirror -MirrorUser $mirror -NewUser $upn)) { $out.Add($a) }
            foreach ($a in (Invoke-CtgExchangeSharedMailboxMirror -MirrorUser $mirror -NewUser $upn)) { $out.Add($a) }
        }
    } catch {
        # The AAD error tells you WHICH problem it is — don't always blame "grant Exchange.ManageAsApp".
        $emsg = [string]$_.Exception.Message
        $appId = try { [string]$s.Credential.UserName } catch { '' }
        $org = try { [string](Get-CtgExoOrganization $Job $Creds) } catch { '' }
        $hint =
            if ($emsg -match 'AADSTS700016|was not found in the directory|AADSTS90002|AADSTS70011|Invalid scope') {
                "the EXO app '$appId' isn't registered/consented in tenant '$org'. Fix the m365-admin secret's app id so it's an app that EXISTS in THIS client's tenant (not another client's), and admin-consent it there (a multi-tenant app must be consented in the tenant to create its service principal). Confirm '$org' is the correct tenant domain."
            }
            elseif ($emsg -match 'AADSTS7000215|invalid client secret|AADSTS700027|AADSTS500011|certificate|Key was not found') {
                "EXO app-only is CERTIFICATE auth (not a client secret): set CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows) on the m365-admin secret, and upload that same cert to the app registration."
            }
            elseif ($emsg -match 'Unauthorized|Access.?Denied|do(es)? not have permission|ManageAsApp|insufficient|forbidden') {
                "grant the m365-admin app the Exchange.ManageAsApp APPLICATION permission (admin consent), AND add its service principal to the Exchange Administrator role in '$org' — EXO app-only needs both."
            }
            else {
                "grant the m365-admin app Exchange.ManageAsApp + set its cert (CertificateBase64 or CertificateThumbprint) on the secret."
            }
        $out.Add("WARN Exchange Online finish failed ($emsg) — $hint")
    }
    return $out.ToArray()
}

# named secret to its resolved credential object (.Credential is a pscredential).
$DISPATCH = @{
    'm365' = @{
        Connect  = { param($job, $creds)
            $tenant = Get-CtgTenantDomain $job $creds
            # Phase carries WHAT we're attempting (tenant + app id, never the secret) so a failure
            # reads "while connecting to m365 (tenant X, app Y): <error>" instead of a bare error.
            Set-CtgPhase $job.id "connecting to m365 (tenant $tenant, app $($creds['m365-admin'].Credential.UserName))"
            Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $tenant
        }
        Onboard  = { param($job, $creds)
            $r = Invoke-CtgM365Onboarding -User $job.payload -Config $job.config -InitialPassword (Resolve-CtgInitialPassword -Job $job -Creds $creds)
            # Finish over Exchange Online with the SAME m365-admin app (cert) — no separate Exchange
            # system needed: the DLs Graph couldn't write, plus (when mirroring) the mirror user's DLs
            # and shared-mailbox permissions. One EXO connection, best-effort.
            $dls = @(if ($r.PSObject.Properties['DeferredDistributionGroups']) { $r.DeferredDistributionGroups })
            $mirror = [string](Get-CtgProp $job.config 'mirrorFromUser')
            # skipExoFinish: set by the planner on the entra lane when m365 is ALSO modeled (same module),
            # so the costly EXO mirror runs once on m365 instead of twice. Skip it here when set.
            if ((Get-CtgProp $job.config 'skipExoFinish')) {
                $r.Actions = @($r.Actions) + "EXO finish skipped — handled by the m365 lane (entra is the same module)"
            }
            elseif ($dls.Count -gt 0 -or $mirror) {
                foreach ($a in (Invoke-CtgM365ExoFinish -Job $job -Creds $creds -Names $dls -MirrorUser $mirror)) { $r.Actions = @($r.Actions) + $a }
            }
            $r
        }
        Offboard = { param($job, $creds) Invoke-CtgM365Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgM365 -User $job.payload -Config $job.config -Action $job.action }
    }
    'active-directory' = @{
        Onboard  = { param($job, $creds) Invoke-CtgADOnboarding  -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Offboard = { param($job, $creds) Invoke-CtgADOffboarding -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Validate = { param($job, $creds) Confirm-CtgAD -User (Add-ClientContext $job) -Config $job.config -Action $job.action -AdConnection (New-CtgAdConnection $creds) }
    }
    # Write the cloud-assigned email back into AD's `mail` attribute (onboard only). Runs on the client
    # agent via the ActiveDirectory module; the app injects `writebackEmail` into the payload at dispatch.
    'ad-email-writeback' = @{
        Onboard  = { param($job, $creds) Invoke-CtgADEmailWriteback -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Validate = { param($job, $creds) Confirm-CtgADEmailWriteback -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
    }
    # Hybrid identity-link check (onboard only, DETECT-ONLY): does the on-prem object's source anchor
    # match the Entra immutableId, or would it duplicate? The app injects the Entra object's anchor data.
    'ad-consistency-check' = @{
        Onboard = { param($job, $creds) Invoke-CtgADConsistencyCheck -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
    }
    # Operator-confirmed hard-match: write mS-DS-ConsistencyGuid = the Entra immutableId (app-injected)
    # so AAD Connect links the objects. Dispatched on demand by the "Link" action, not part of a plan.
    'ad-hard-match' = @{
        Onboard = { param($job, $creds) Invoke-CtgADHardMatch -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
    }
    'mimecast' = @{
        # Mimecast API 2.0: OAuth2 client-credentials. Template-tolerant — the client id can live in
        # Username OR a ClientID-style field ("Automation - API" template), the client secret in
        # Password OR a ClientSecret-style field. Fails with the fields it saw, never a null-binding.
        Connect  = { param($job, $creds)
            $s = $creds['mimecast']
            if (-not $s) { throw "the job did not broker a 'mimecast' secret — make sure the client's mimecast system lists 'mimecast' in its secrets" }
            $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
            $id = & $pick @('ClientID', 'ClientId', 'Client ID', 'AppId', 'Application ID', 'Username')
            $secret = & $pick @('ClientSecret', 'Client Secret', 'Secret', 'API Key', 'ApiKey', 'AccessToken', 'Token', 'Password')
            if (-not $id -or -not $secret) {
                throw "the 'mimecast' secret needs a CLIENT ID (Username or ClientID field) + CLIENT SECRET (Password or ClientSecret field) from the API 2.0 application; the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/mimecast)"
            }
            Connect-CtgMimecast -Credential ([pscredential]::new([string]$id, (ConvertTo-SecureString ([string]$secret) -AsPlainText -Force)))
        }
        Onboard  = { param($job, $creds) Invoke-CtgMimecastOnboarding  -User $job.payload -Config $job.config -InitialPassword (ConvertFrom-SecureString (Resolve-CtgInitialPassword -Job $job -Creds $creds) -AsPlainText) }
        Offboard = { param($job, $creds) Invoke-CtgMimecastOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgMimecast -User $job.payload -Config $job.config -Action $job.action }
    }
    'directory-sync' = @{
        # ad-dc credential lets the runner remote into the Entra Connect host (config.host) when the
        # ADSync module isn't on this agent's box (Model A: one DC runner remotes to Core-CCE-AzSync).
        Onboard  = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config -Credential ($creds['ad-dc']).Credential }
        Offboard = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config -Credential ($creds['ad-dc']).Credential }
        Validate = { param($job, $creds) Confirm-CtgDirectorySync -User $job.payload -Config $job.config -Action $job.action -Credential ($creds['ad-dc']).Credential }
    }
    'exchange' = @{
        # EXO app-only needs certificate auth (m365-admin carries the cert thumbprint). A hybrid
        # onboard ALSO needs an on-prem Exchange session for Enable-RemoteMailbox — established only
        # when the job brokered the `exchange-onprem` secret (its Fields carry the PowerShell URI).
        Connect  = { param($job, $creds)
            $s = $creds['m365-admin']
            Set-CtgPhase $job.id "connecting to Exchange Online (app-only cert auth, app $($s.Credential.UserName))"
            $exoCert = Get-CtgExoCertArgs $s
            if ($exoCert.Count -eq 0) { throw "the m365-admin secret has no Exchange Online cert — set CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows store), and grant the app Exchange.ManageAsApp." }
            Connect-CtgExchange -AppId $s.Credential.UserName -Organization (Get-CtgExoOrganization $job $creds) @exoCert
            # On-prem session for BOTH lanes when the `exchange-onprem` secret is brokered: onboard
            # needs Enable-RemoteMailbox; a HYBRID offboard needs Set-RemoteMailbox -Type Shared
            # (an EXO Set-Mailbox would be overwritten by AD Connect on an on-prem-mastered mailbox).
            # The credential may reuse the ad-dc Delinea id (the domain admin already has Exchange
            # rights). The PowerShell URI comes from the secret's ConnectionUri field if present, else
            # the system config (`onPremExchangeUri`) — so reusing ad-dc needs no extra Delinea field.
            $op = $creds['exchange-onprem']
            if ($op) {
                # The PowerShell endpoint URI can live in any of these secret fields (so an existing
                # "Document Link"/"URL" field can be reused instead of adding a ConnectionUri one),
                # else falls back to the exchange system config's onPremExchangeUri.
                $pickUri = { param($names) foreach ($k in $names) { if ($op.Fields.ContainsKey($k) -and $op.Fields[$k]) { return [string]$op.Fields[$k] } } $null }
                $opUri = & $pickUri @('ConnectionUri', 'ConnectionUrl', 'ConnectionURL', 'Uri', 'Url', 'URL', 'PowerShellUri', 'PowerShellUrl', 'Link', 'DocumentLink', 'Document Link')
                # System config: a real job's config is the action sub-object (top-level key); a
                # connection test passes the whole config, so also look under onboard/offboard.
                if (-not $opUri) {
                    $cfg = $job.config
                    $opUri = [string]((Get-CtgProp $cfg 'onPremExchangeUri') ?? (Get-CtgProp (Get-CtgProp $cfg 'offboard') 'onPremExchangeUri') ?? (Get-CtgProp (Get-CtgProp $cfg 'onboard') 'onPremExchangeUri'))
                }
                if (-not $opUri) { throw "the on-prem Exchange session needs a PowerShell URI — set ConnectionUri (or a Document Link / URL field) on the exchange-onprem secret, or onPremExchangeUri on the exchange system. e.g. http://core-cce1-ex01.core.tech/PowerShell/" }
                Set-CtgPhase $job.id "connecting to on-prem Exchange ($opUri)"
                Connect-CtgExchangeOnPrem -ConnectionUri $opUri -Credential $op.Credential
            }
        }
        # Hybrid onboard, one pass across the sync boundary: enable remote mailbox -> trigger an Entra
        # Connect delta sync (so the mailbox provisions now) -> wait for it -> regional/calendar. The
        # sync trigger reuses the on-prem (ad-dc) credential and auto-discovers the Entra Connect host.
        Onboard  = { param($job, $creds)
            # CLOUD client (no on-prem Exchange session brokered): the M365 license already made the
            # mailbox, so skip Enable-RemoteMailbox and just do the EXO-only work — add the requested
            # distribution lists by name. HYBRID (on-prem session present): the full remote-mailbox pass.
            if (-not $creds['exchange-onprem']) {
                Invoke-CtgExchangeCloudOnboard -User $job.payload -Config $job.config
            }
            else {
                $syncCred = ($creds['exchange-onprem']).Credential
                $trigger = if ($syncCred) { { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) -Credential $syncCred | Out-Null }.GetNewClosure() } else { $null }
                Invoke-CtgExchangeHybridOnboard -User $job.payload -Config $job.config -TriggerSync $trigger
            }
        }
        Offboard = { param($job, $creds)
            # Pass a delta-sync trigger (reusing the on-prem credential) so a HYBRID convert-to-shared
            # via Set-RemoteMailbox is pushed to the cloud immediately; cloud-only offboards ignore it.
            $op = $creds['exchange-onprem']
            $syncCred = if ($op) { $op.Credential } else { $null }
            $trigger = if ($syncCred) { { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) -Credential $syncCred | Out-Null }.GetNewClosure() } else { $null }
            Invoke-CtgExchangeOffboarding -User $job.payload -Config $job.config -TriggerSync $trigger
        }
        Validate = { param($job, $creds) Confirm-CtgExchange -User $job.payload -Config $job.config -Action $job.action }
    }
    'zoom' = @{
        Connect  = { param($job, $creds) Use-CtgZoomSecret -Job $job -Creds $creds }
        Onboard  = { param($job, $creds) Invoke-CtgZoomOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgZoomOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgZoom -User $job.payload -Config $job.config -Action $job.action }
    }
    'adobe' = @{
        Connect  = { param($job, $creds) Connect-CtgAdobe -Credential $creds['adobe'].Credential -OrgId $creds['adobe'].Fields['OrgId'] }
        Onboard  = { param($job, $creds) Invoke-CtgAdobeOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgAdobeOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgAdobe -User $job.payload -Config $job.config -Action $job.action }
    }
    'perimeter81' = @{
        Connect  = { param($job, $creds) Connect-CtgPerimeter81 -ApiKey $creds['perimeter81'].Fields['ApiKey'] }
        Onboard  = { param($job, $creds) Invoke-CtgPerimeter81Onboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgPerimeter81Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgPerimeter81 -User $job.payload -Config $job.config -Action $job.action }
    }
    'egnyte' = @{
        # Egnyte: per-tenant host https://{Domain}.egnyte.com, OAuth2 bearer. Secret fields:
        # Domain (the tenant subdomain, e.g. "drakestar") + either a long-lived Token (preferred —
        # Egnyte tokens don't expire) or ClientID (the API key) + Username/Password (service
        # account) for the password grant. Template-tolerant field matching; actionable errors.
        Connect  = { param($job, $creds)
            $s = $creds['egnyte']
            if (-not $s) { throw "the job did not broker an 'egnyte' secret — make sure the client's egnyte system lists 'egnyte' in its secrets" }
            $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
            $domain = & $pick @('Domain', 'EgnyteDomain', 'Tenant', 'AccountID', 'AccountId')
            if (-not $domain) { throw "the 'egnyte' secret has no Domain field — set it to the tenant subdomain (e.g. 'drakestar' for drakestar.egnyte.com); the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/egnyte)" }
            $token = & $pick @('Token', 'AccessToken', 'Access Token', 'ApiToken', 'API Key', 'APIKey', 'Api Key', 'ApiKey', 'Bearer')
            if ($token) { Connect-CtgEgnyte -Domain $domain -Token $token }
            else {
                $clientId = & $pick @('ClientID', 'ClientId', 'Client ID', 'Key')
                if (-not $clientId -or -not $s.Credential) { throw "the 'egnyte' secret needs either a Token field (preferred) or ClientID + Username/Password for the password grant; the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/egnyte)" }
                Connect-CtgEgnyte -Domain $domain -ClientId $clientId -Credential $s.Credential
            }
        }
        Onboard  = { param($job, $creds) Invoke-CtgEgnyteOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgEgnyteOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgEgnyte -User $job.payload -Config $job.config -Action $job.action }
    }
    'spanning' = @{
        # Spanning Backup: HTTP Basic auth, username = the CLIENT ID, password = the CLIENT SECRET
        # (see Use-CtgSpanningSecret). NO Connect block ON PURPOSE: Connect-CtgSpanning is a pure
        # local assignment (no network), so each lane just re-reads the brokered secret (free) —
        # which also means a rotated credential applies on the very next job.
        Onboard  = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Invoke-CtgSpanningOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Invoke-CtgSpanningOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Confirm-CtgSpanning -User $job.payload -Config $job.config -Action $job.action }
    }
    'proofpoint' = @{
        # Proofpoint Essentials: read-only sync verification (X-User/X-Password admin auth). No Connect
        # block — Connect-CtgProofpoint is a pure local assignment, so each lane re-reads the brokered
        # secret (a rotated credential applies on the next job). Provisioning is sync-driven; the lanes
        # verify presence and (on onboard) auto-retry until Proofpoint's scheduled sync imports the user.
        Onboard  = { param($job, $creds) Use-CtgProofpointSecret $job $creds; Invoke-CtgProofpointOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgProofpointSecret $job $creds; Invoke-CtgProofpointOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgProofpointSecret $job $creds; Confirm-CtgProofpoint -User $job.payload -Config $job.config -Action $job.action }
    }
    '1password' = @{
        # Method-aware (config.method: auto|api|scim|manual|browser). No standing Connect block: each lane
        # decides via Connect-Ctg1PasswordForJob whether to establish an `op` admin session (api requires
        # it; auto/scim are best-effort -> $connected drives the module's manual fallback / verify).
        Onboard  = { param($job, $creds) $c = Connect-Ctg1PasswordForJob $job $creds; Invoke-Ctg1PasswordOnboarding  -User $job.payload -Config $job.config -Connected $c }
        Offboard = { param($job, $creds) $c = Connect-Ctg1PasswordForJob $job $creds; Invoke-Ctg1PasswordOffboarding -User $job.payload -Config $job.config -Connected $c }
        Validate = { param($job, $creds) $c = Connect-Ctg1PasswordForJob $job $creds; Confirm-Ctg1Password -User $job.payload -Config $job.config -Action $job.action -Connected $c }
    }
    'google-workspace' = @{
        Connect  = { param($job, $creds) Use-CtgGoogleSecret -Job $job -Creds $creds }
        Onboard  = { param($job, $creds) Invoke-CtgGoogleOnboarding  -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        Offboard = { param($job, $creds) Invoke-CtgGoogleOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgGoogle -User $job.payload -Config $job.config -Action $job.action }
    }
    'salesforce' = @{
        Connect  = { param($job, $creds) Use-CtgSalesforceSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgSalesforceOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgSalesforceOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgSalesforce -User $job.payload -Config $job.config -Action $job.action }
    }
    'knowbe4' = @{
        # No network in Connect — re-broker the SCIM token each lane (a rotated token applies next job).
        Onboard  = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Invoke-CtgKnowBe4Onboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Invoke-CtgKnowBe4Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Confirm-CtgKnowBe4 -User $job.payload -Config $job.config -Action $job.action }
    }
    'jira' = @{
        Onboard  = { param($job, $creds) Use-CtgJiraSecret $job $creds; Invoke-CtgJiraOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgJiraSecret $job $creds; Invoke-CtgJiraOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgJiraSecret $job $creds; Confirm-CtgJira -User $job.payload -Config $job.config -Action $job.action }
    }
    'hubspot' = @{
        Onboard  = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Invoke-CtgHubSpotOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Invoke-CtgHubSpotOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Confirm-CtgHubSpot -User $job.payload -Config $job.config -Action $job.action }
    }
    'sentinelone' = @{
        # Connect key (vs inline) so the connection-test harness can exercise it; the job loop's
        # connect-cache re-brokers when the credential fingerprint changes (rotated token next job).
        Connect  = { param($job, $creds) Use-CtgSentinelOneSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgSentinelOneOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds)
            # In-app "Reconnect": a one-off job carrying config.reconnect = @{ agentId; machine } — undo an
            # isolation rather than create one.
            $rc = Get-CtgProp $job.config 'reconnect'
            if ($rc) { return Invoke-CtgSentinelOneReconnect -AgentId ([string](Get-CtgProp $rc 'agentId')) -Machine ([string](Get-CtgProp $rc 'machine')) }
            # Normal offboard: network-isolate EVERY one of the user's Entra-registered devices.
            Invoke-CtgSentinelOneOffboarding -User $job.payload -Config $job.config -Machines (Get-CtgSentinelOneMachines $job $creds)
        }
        Validate = { param($job, $creds) Confirm-CtgSentinelOne -User $job.payload -Config $job.config -Action $job.action -Machines (Get-CtgSentinelOneMachines $job $creds) }
    }
    'duo' = @{
        Onboard  = { param($job, $creds) Use-CtgDuoSecret $job $creds; Invoke-CtgDuoOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgDuoSecret $job $creds; Invoke-CtgDuoOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgDuoSecret $job $creds; Confirm-CtgDuo -User $job.payload -Config $job.config -Action $job.action }
    }
    'xmatters' = @{
        Connect  = { param($job, $creds) Use-CtgXMattersSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgXMattersOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgXMattersOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgXMatters -User $job.payload -Config $job.config -Action $job.action }
    }
    'logicmonitor' = @{
        Onboard  = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Invoke-CtgLogicMonitorOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Invoke-CtgLogicMonitorOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Confirm-CtgLogicMonitor -User $job.payload -Config $job.config -Action $job.action }
    }
    'notify' = @{
        # Sends offboard emails via Graph sendMail using the m365-admin app — reuse the m365 Connect so
        # the ambient Microsoft.Graph context (Send-MgUserMail) is established. Runs last in the offboard.
        Connect  = { param($job, $creds)
            $tenant = Get-CtgTenantDomain $job $creds
            Set-CtgPhase $job.id "connecting to Graph for notifications (tenant $tenant, app $($creds['m365-admin'].Credential.UserName))"
            Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $tenant
        }
        Onboard  = { param($job, $creds) Invoke-CtgNotifyOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgNotifyOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgNotify -User $job.payload -Config $job.config -Action $job.action }
    }
}

# entra is the Entra-ID slice of the M365 module — same executor + read-backs (catalog
# moduleName = Coretelligent.M365). Alias it so an `entra` job isn't left without an executor.
$DISPATCH['entra'] = $DISPATCH['m365']

# Ad-hoc "Generate random password" (INC0855142): dispatched on demand from a case's account line,
# never planned. The app generates the value, injects it as config.newPassword at claim, and reveals
# it once operator-side — the executors never return it. One executor per system serves both lanes
# (the wire `action` is the CASE's, and a reset can ride either kind of case); Connect lanes are
# aliased from the owning system so a connection fix reaches the reset automatically.
$DISPATCH['ad-password-reset'] = @{
    Onboard = { param($job, $creds) Invoke-CtgADPasswordReset -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
}
$DISPATCH['m365-password-reset'] = @{
    Connect = $DISPATCH['m365'].Connect
    Onboard = { param($job, $creds) Invoke-CtgM365PasswordReset -User $job.payload -Config $job.config }
}
$DISPATCH['google-password-reset'] = @{
    Connect = $DISPATCH['google-workspace'].Connect
    Onboard = { param($job, $creds) Invoke-CtgGooglePasswordReset -User $job.payload -Config $job.config }
}
foreach ($k in 'ad-password-reset', 'm365-password-reset', 'google-password-reset') { $DISPATCH[$k].Offboard = $DISPATCH[$k].Onboard }

# Ad-hoc "force Spanning sync" (browser automation): dispatched on demand from a case's Spanning step
# to make Spanning discover a just-created M365 user NOW (the Spanning API has no sync endpoint). Rides
# the Spanning line's brokered secret; no Connect lane (the browser flow does its own portal login).
# One executor serves both lanes (a force-sync can ride an onboard or an offboard case). Withheld from
# agents that don't report the 'browser' capability (see $script:RunnerCapabilities below).
$DISPATCH['spanning-force-sync'] = @{
    # OtpRequest is a REQUEST SPEC the browser flow itself calls when the MFA box is actually visible,
    # so the 30-second Delinea-minted code can't go stale in transit (browser launch + portal load +
    # the SSO hop routinely outlive a TOTP window). The seed stays in Delinea; we only ever hold a code.
    Onboard = { param($job, $creds)
        Invoke-CtgSpanningForceSync -User $job.payload -Config $job.config -Secret $creds['spanning'] `
            -OtpRequest @{ url = "$AppUrl/api/jobs/$($job.id)/credential"; token = $ApiToken; agentId = $AgentId; secretName = 'spanning' }
    }
}
$DISPATCH['spanning-force-sync'].Offboard = $DISPATCH['spanning-force-sync'].Onboard

# tap issues an Entra Temporary Access Pass — same Graph connection as m365, its own onboard executor.
# Offboard/Validate are no-ops (the TAP is short-lived and self-expires; nothing to tear down/verify).
$DISPATCH['tap'] = @{
    Connect  = $DISPATCH['m365'].Connect
    Onboard  = { param($job, $creds) Invoke-CtgEntraTap -User (Add-ClientContext $job) -Config $job.config }
    Offboard = { param($job, $creds) [pscustomobject]@{ System = 'tap'; Status = 'ok'; Actions = @('no TAP teardown needed (it self-expires)') } }
    Validate = { param($job, $creds) [pscustomobject]@{ System = 'tap'; Ok = $true; Detail = 'TAP is issue-only (self-expiring); nothing to verify' } }
}

# Action -> validate, with idempotent auto-retry. On a validation miss we re-run the (idempotent)
# action and re-validate up to $MaxRevalidate times — this self-heals eventual-consistency lags.
# A persistent miss is NOT a failure: the job still succeeds; the validation block (ok=$false)
# rides along on the result and the app's run report flags it as a warning.
$MaxRevalidate = 2

function Invoke-JobWithValidation {
    param($Job, $Handler, [scriptblock]$Fn, $Creds, [bool]$DryRun)

    # Dry run: set WhatIf so every module's SupportsShouldProcess short-circuits the mutations, then
    # run the validators read-only. MUST be $global: — module functions (Coretelligent.*) resolve
    # preference variables from their own/module/GLOBAL scope, NOT the caller's, so a local
    # $WhatIfPreference here would be ignored and the executors would run LIVE despite dry-run.
    if ($DryRun) { $global:WhatIfPreference = $true }
    try { $result = & $Fn $Job $Creds }
    finally { if ($DryRun) { $global:WhatIfPreference = $false } }

    $validate = if ($Handler.ContainsKey('Validate')) { $Handler['Validate'] } else { $null }
    $validation = $null
    if ($validate) {
        $validation = & $validate $Job $Creds
        $attempt = 0
        while ($validation -and -not $validation.ok -and -not $DryRun -and $attempt -lt $MaxRevalidate) {
            Start-Sleep -Seconds (2 * ($attempt + 1))
            $result = & $Fn $Job $Creds          # idempotent re-run
            $validation = & $validate $Job $Creds
            $attempt++
        }
    }
    [pscustomobject]@{ Result = $result; Validation = $validation }
}

# Track which tenant+credential each system's Connect block is CURRENTLY connected with. The
# Coretelligent.* modules hold exactly one connection in module state (Connect-Ctg* overwrites it),
# so a per-(system|tenant) "already connected" set is wrong on a multi-client runner: an A->B->A
# job interleave would skip A's reconnect and silently run A's job against B's tenant. Keying
# system -> "tenant|credential-fingerprint" reconnects on every tenant switch AND on credential
# rotation (and keeps blank-domain clients with different secret TenantIds apart).
$script:ConnectedTenant = @{}

# ...but the cache is keyed per systemKey, and several systemKeys drive the SAME ambient connection:
#   graph  — m365, its 'entra' alias, m365-password-reset, tap and notify all Connect-CtgM365 with
#            the m365-admin credential (Connect-MgGraph holds ONE process-wide context).
#   google — google-workspace + google-password-reset share one Google session.
# So the A->B->A interleave above reappears ACROSS keys: an m365 job for client A connects Graph to A;
# an entra job for client B rebinds that same Graph session to B; a second m365 job for A then finds
# ConnectedTenant['m365'] still == A's key, SKIPS Connect, and provisions/offboards A's user inside
# B's tenant. Whenever a shared session is (re)bound, forget the SIBLING keys so they reconnect.
$script:ConnectionGroups = @{
    graph  = @('m365', 'entra', 'm365-password-reset', 'tap', 'notify')
    google = @('google-workspace', 'google-password-reset')
}

# The other systemKeys that share an ambient connection with this one ('' when it owns its session).
function Get-CtgConnectionSiblings {
    param([string]$SystemKey)
    foreach ($group in $script:ConnectionGroups.Values) {
        if ($group -contains $SystemKey) { return @($group | Where-Object { $_ -ne $SystemKey }) }
    }
    return @()
}

# Drop the connect-cache entries that no longer describe the ambient connection. Call AFTER any
# Connect that (re)binds a shared session. -IncludeSelf when the connection was established outside
# the cached path (a conn-test, cloud-group discovery) so no real job may reuse it.
function Clear-CtgConnectionSiblings {
    param([string]$SystemKey, [switch]$IncludeSelf)
    if (-not $script:ConnectedTenant) { return }
    foreach ($sibling in (Get-CtgConnectionSiblings $SystemKey)) { [void]$script:ConnectedTenant.Remove($sibling) }
    if ($IncludeSelf) { [void]$script:ConnectedTenant.Remove($SystemKey) }
}

# A short, non-reversible fingerprint of every brokered secret's fields for this job. Used ONLY as
# a connect-cache key component — never logged, never sent anywhere. SHA-256 over sorted
# name.field=value pairs, truncated.
function Get-CtgCredFingerprint {
    param($Creds)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($name in (@($Creds.Keys) | Sort-Object)) {
        $c = $Creds[$name]
        if (-not $c -or -not $c.Fields) { continue }
        foreach ($k in (@($c.Fields.Keys) | Sort-Object)) { [void]$sb.Append("$name.$k=$($c.Fields[$k]);") }
    }
    $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
    ([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16)
}

# The on-prem AD module needs the client's primary domain to build the OU DN; fold it in from
# the job's client context if the intake payload didn't carry it.
function Add-ClientContext {
    param($Job)
    $u = $Job.payload
    if ($u -and -not $u.PSObject.Properties['PrimaryDomain']) {
        $u | Add-Member -NotePropertyName PrimaryDomain -NotePropertyValue $Job.client.primaryDomain -Force
    }
    $u
}

# ONE shared HttpClient for every app call — reuses TCP connections (keep-alive) instead of opening a
# new socket per request. PowerShell's Invoke-RestMethod creates + disposes a fresh HttpClient PER CALL,
# so a long-running poller churns a connection per heartbeat/claim/progress; the host's ephemeral ports
# fill with TIME_WAIT sockets and every outbound connect eventually fails ("Can't assign requested
# address" / "can't reach the database"). A pooled client keeps it to a handful of reused connections.
# GLOBAL so the module-scope Send-CtgProgress can reuse the same client.
$global:CtgHttp = $null
function global:Get-CtgHttpClient {
    if ($null -eq $global:CtgHttp) {
        $h = [System.Net.Http.SocketsHttpHandler]::new()
        $h.PooledConnectionLifetime    = [TimeSpan]::FromMinutes(5)
        $h.PooledConnectionIdleTimeout = [TimeSpan]::FromMinutes(2)
        $h.MaxConnectionsPerServer     = 8
        $c = [System.Net.Http.HttpClient]::new($h)
        $c.Timeout = [TimeSpan]::FromSeconds(300)
        $global:CtgHttp = $c
    }
    $global:CtgHttp
}

function global:Invoke-CtgHttp {
    # Shared-client request → parsed JSON (or $null). Throws "HTTP <code> — <body>" on non-2xx, matching
    # the Invoke-RestMethod behaviour callers relied on. Disposes the request/response, NOT the client.
    param([string]$Method, [string]$Uri, [hashtable]$Headers, [string]$Body)
    $msg = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
    try {
        if ($Headers) {
            foreach ($k in $Headers.Keys) {
                if ($k -ieq 'Authorization') { $msg.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::Parse([string]$Headers[$k]) }
                else { [void]$msg.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) }
            }
        }
        if ($Body) { $msg.Content = [System.Net.Http.StringContent]::new($Body, [System.Text.Encoding]::UTF8, 'application/json') }
        # SendAsync throws on timeout/network failure — the finally still disposes $msg (it previously
        # leaked the request message, incl. its StringContent, on every failed heartbeat/poll ~17k/day).
        $resp = (Get-CtgHttpClient).SendAsync($msg).GetAwaiter().GetResult()
        try {
            $code = [int]$resp.StatusCode
            $ok   = $resp.IsSuccessStatusCode
            $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $ok) { throw "HTTP ${code}: $Method $Uri$(if ($text) { " — $text" })" }
            if ($text) { return ($text | ConvertFrom-Json) }
            return $null
        }
        finally { $resp.Dispose() }
    }
    finally { $msg.Dispose() }
}

function Invoke-AppApi {
    param([string]$Method, [string]$Path, $Body)
    # ngrok-skip-browser-warning bypasses ngrok-free's HTML interstitial (harmless on other hosts).
    $headers = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $headers['Authorization'] = "Bearer $ApiToken" }
    $json = if ($Body) { ($Body | ConvertTo-Json -Depth 12) } else { $null }
    Invoke-CtgHttp -Method $Method -Uri "$AppUrl$Path" -Headers $headers -Body $json  # mTLS replaces the bearer in production
}

function global:Send-CtgProgress {
    # Post one progress line for the current job. GLOBAL on purpose: the Coretelligent.* modules run in
    # their own scope and can't see the runner's script functions — only global ones — so a long module
    # operation (e.g. the Exchange mailbox sync-wait) can call this to emit a "still trying" heartbeat.
    # Reads per-job globals; best-effort (a failed post never breaks the job).
    param([string]$Message)
    # Touch the watchdog heartbeat first: a narration means the runner made progress just now, so the
    # stall watchdog must not restart it. mtime is the signal (body is human-readable). Inlined rather
    # than calling the module's Update-CtgHeartbeat so it's reachable from module scope with no
    # cross-scope lookup (same reason this function is global). Best-effort.
    if ($global:CtgHeartbeatFile) { try { [System.IO.File]::WriteAllText($global:CtgHeartbeatFile, "$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())`n$Message") } catch { } }
    $jid = $global:CtgProgressJobId
    if (-not $jid) { return }
    $h = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($global:CtgProgressToken) { $h['Authorization'] = "Bearer $($global:CtgProgressToken)" }
    # Shared pooled client (Invoke-CtgHttp) — NOT Invoke-RestMethod. Progress is the highest-frequency
    # call (every narration line during a job), so a fresh socket each time was the worst port-churn.
    try { Invoke-CtgHttp -Method POST -Uri "$($global:CtgProgressUrl)/api/jobs/$jid/progress" -Headers $h -Body (@{ agentId = $global:CtgProgressAgent; phase = $Message } | ConvertTo-Json) | Out-Null } catch { }
}

function Set-CtgPhase {
    # Record what we're doing right now: keep it in $script:Phase (so a thrown error can say WHICH
    # phase failed instead of a bare "Unauthorized"), and beacon it to the app so the run report can
    # show live progress. Routes through the global poster so module + runner share one path.
    param([string]$JobId, [string]$Phase)
    $script:Phase = $Phase
    if ($JobId) { $global:CtgProgressJobId = $JobId }
    Write-Host "  · $Phase" -ForegroundColor DarkGray
    Send-CtgProgress $Phase
}

# Self-heal: only auto-install modules that are part of our trusted IAM toolchain — never an arbitrary
# gallery module conjured from a typo'd cmdlet name.
$script:CtgAutoInstallModules = @('Microsoft.Graph.*', 'ExchangeOnlineManagement', 'MSOnline', 'AzureAD', 'AzureADPreview', 'Az.*', 'ADSync', 'ActiveDirectory')

function Get-CtgMissingCommandName {
    # Pull the unresolved command name out of a CommandNotFoundException (or its "The term 'X' is not
    # recognized" message). Returns $null when the error isn't a missing-command.
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    while ($ex) {
        if ($ex -is [System.Management.Automation.CommandNotFoundException]) { return $ex.CommandName }
        $ex = $ex.InnerException
    }
    $m = "$($ErrorRecord.Exception.Message)"
    if ($m -match "[Tt]he term '([^']+)' is not recognized") { return $matches[1] }
    return $null
}

function Repair-CtgMissingModule {
    # Given a missing cmdlet, find the gallery module that provides it and install+import it — but only
    # if that module is in our trusted allowlist. Returns the module name on success, else $null.
    param([string]$CommandName)
    if (-not $CommandName) { return $null }
    if (-not (Get-Command Find-Command -ErrorAction SilentlyContinue)) { return $null }  # needs PowerShellGet
    $mod = $null
    try { $mod = (Find-Command -Name $CommandName -ErrorAction Stop | Select-Object -First 1).ModuleName } catch { return $null }
    if (-not $mod) { return $null }
    $trusted = $false
    foreach ($p in $script:CtgAutoInstallModules) { if ($mod -like $p) { $trusted = $true; break } }
    if (-not $trusted) { Write-Warning "self-heal: '$CommandName' is in module '$mod', not on the auto-install allowlist — skipping"; return $null }
    try {
        # The runner is detached (no stdin), so Install-Module must NEVER prompt or it hangs forever.
        Initialize-CtgGallery
        # Microsoft.Graph submodules must all carry the SAME version or the next import dies with
        # "Assembly with same name is already loaded" (see Repair-CtgGraphVersionSkew). Pin a new
        # Graph submodule to the version already on the host instead of grabbing the gallery latest.
        $reqVer = $null
        if ($mod -like 'Microsoft.Graph*') {
            $auth = Get-Module -ListAvailable -Name 'Microsoft.Graph.Authentication' -ErrorAction SilentlyContinue |
                Sort-Object Version -Descending | Select-Object -First 1
            if ($auth) { $reqVer = $auth.Version }
        }
        if ($reqVer) {
            # The pinned version may not exist for this submodule (older set; unlisted release) —
            # fall back to the gallery latest rather than failing the self-heal permanently. The
            # startup skew guard then aligns the rest of the set upward on the next boot.
            try { Install-Module $mod -RequiredVersion $reqVer -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop }
            catch {
                Write-Warning "self-heal: $mod has no version $reqVer — installing latest instead (the skew guard re-aligns at next start)"
                Install-Module $mod -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop
            }
        }
        else { Install-Module $mod -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop }
        Import-Module $mod -Force -ErrorAction Stop
        return $mod
    } catch { Write-Warning "self-heal: failed to install '$mod' for '$CommandName': $($_.Exception.Message)"; return $null }
}

function Update-CtgRunner {
    # Operator clicked "Update": re-pull every runner file from the app's manifest into our own
    # folder, then relaunch this script (new pwsh process = new code) and exit. Re-runnable and
    # self-contained so the operator never has to hand-walk a re-pull on the host again.
    $H = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }
    Write-Host "self-update: pulling latest runner from $AppUrl" -ForegroundColor Yellow
    $manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H -TimeoutSec 30
    foreach ($rel in $manifest.files) {
        # Manifest paths are POSIX-style ('a/b/c'); Join-Path accepts '/' on Windows and it's native
        # on macOS/Linux, so use $rel as-is rather than forcing a backslash (which would corrupt
        # paths on a non-Windows central runner).
        $dest = Join-Path $PSScriptRoot $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        $resp = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H -TimeoutSec 60
        [System.IO.File]::WriteAllText($dest, $resp.Content)
    }
    # PRUNE files no longer in the bundle. Pulling-without-deleting leaves stale leftovers (a removed/
    # renamed module), and Get-CtgBuildId hashes EVERY file in the folder — so one leftover makes our
    # build id differ from the app's forever: "update available" that re-pulls but never converges
    # ("updated, back online… still the same version"). Keep only manifest files + the runtime files
    # the hash already excludes (.build, .runner.lock, *.log). Mirrors Get-CtgBuildId's skip-list.
    $want = @{}; foreach ($rel in $manifest.files) { $want[(Join-Path $PSScriptRoot $rel)] = $true }
    foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -ErrorAction SilentlyContinue) {
        if ($want.ContainsKey($f.FullName)) { continue }
        if ($f.Name -eq '.build' -or $f.Name -eq '.runner.lock' -or $f.Name -eq '.DS_Store' -or $f.Name -like '*.log') { continue }
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; Write-Host "self-update: pruned stale $($f.Name)" -ForegroundColor DarkYellow } catch { }
    }
    Write-Host "self-update: pulled $($manifest.files.Count) files (build $($manifest.buildId)) — restarting" -ForegroundColor Green
    Invoke-CtgRelaunch -Reason 'self-update'
}

# Re-exec the runner: under a supervisor (RUNNER_SUPERVISED — launchd/systemd/Scheduled Task) just EXIT
# and let it relaunch us (the robust path, no self-spawn double-runner); UNSUPERVISED, spawn our own
# replacement first, then exit. Shared by self-update (after pulling files) and an operator restart
# (heartbeat restart:true — no file pull). Never returns.
function Invoke-CtgRelaunch {
    param([string]$Reason = 'restart')
    if ($env:RUNNER_SUPERVISED) {
        Write-Host "${Reason}: supervised — exiting so the service manager relaunches" -ForegroundColor Green
        exit 0
    }
    # UNSUPERVISED (a hand-started launch): spawn a fresh process on this same script, then exit. On
    # Windows use WMI (Win32_Process.Create) so the child BREAKS AWAY from a SYSTEM Scheduled Task's job
    # object (a Start-Process child would be killed when we exit — the runner would never come back).
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
    $self = Join-Path $PSScriptRoot 'Start-IamRunner.ps1'
    $qq = { param([string]$s) '"' + ($s -replace '"', '\"') + '"' }  # quote args (paths may have spaces)
    $cmd = (& $qq $pwshPath) + ' -NoProfile -ExecutionPolicy Bypass -File ' + (& $qq $self) +
           ' -AppUrl ' + (& $qq $AppUrl) + ' -AgentId ' + (& $qq $AgentId) +
           ' -PollSeconds ' + $PollSeconds + ' -BatchSize ' + $BatchSize +
           ' -ExoModuleVersion ' + (& $qq $ExoModuleVersion)
    if ($ApiToken) { $cmd += ' -ApiToken ' + (& $qq $ApiToken) }
    if ($IsWindows) {
        try {
            $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
            if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
            Write-Host "${Reason}: relaunched (pid $($r.ProcessId))" -ForegroundColor Green
        }
        catch {
            Write-Warning "${Reason} relaunch via WMI failed ($($_.Exception.Message)); using Start-Process"
            Start-Process -FilePath $pwshPath -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion) | Out-Null
        }
    }
    else {
        # macOS/Linux: relaunch DETACHED via a tiny launcher script (`exec … >> log 2>&1` takes pwsh off
        # the dead tty; the Start-Process child survives our exit on Unix).
        $log = if ($env:RUNNER_LOG) { $env:RUNNER_LOG } else { Join-Path $HOME 'iam-runner.log' }
        $a = @($pwshPath, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-AppUrl', $AppUrl, '-AgentId', $AgentId, '-PollSeconds', "$PollSeconds", '-BatchSize', "$BatchSize", '-ExoModuleVersion', $ExoModuleVersion)
        if ($ApiToken) { $a += @('-ApiToken', $ApiToken) }
        $q = { param($s) "'" + ([string]$s -replace "'", "'\''") + "'" }
        $line = (($a | ForEach-Object { & $q $_ }) -join ' ') + " >> $(& $q $log) 2>&1"
        # The launcher embeds -ApiToken, so it must NOT be world-readable. Put it in a private per-launch
        # dir (0700) so it's unreadable even during the brief window before the file's own 0600 lands,
        # and have the launcher delete itself before exec so the token doesn't linger on disk.
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("iam-runner-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        & chmod 700 $dir 2>$null
        $launcher = Join-Path $dir 'relaunch.sh'
        [System.IO.File]::WriteAllText($launcher, "#!/bin/sh`nrm -f `"`$0`" 2>/dev/null; rmdir -- `"$dir`" 2>/dev/null`nexec $line`n")
        & chmod 600 $launcher 2>$null
        Start-Process -FilePath '/bin/sh' -ArgumentList $launcher | Out-Null
        Write-Host "${Reason}: relaunched detached (log: $log)" -ForegroundColor Green
    }
    exit 0
}

# Operator-requested restart (heartbeat restart:true): re-exec WITHOUT pulling new files. Clears a
# wedged claim/work loop while the heartbeat thread stayed alive — the exact "heartbeats but won't
# claim" case. Needs a supervisor to come back cleanly (or the unsupervised self-spawn above).
function Restart-CtgRunner {
    Write-Host "restart: operator requested a restart" -ForegroundColor Yellow
    if (-not $env:RUNNER_SUPERVISED) { Write-Warning "restart requested but RUNNER_SUPERVISED is not set — attempting a self-spawn relaunch; install the supervisor (install-launchd.sh / install-systemd.sh / install-task.ps1) for reliable remote restarts." }
    Invoke-CtgRelaunch -Reason 'restart'
}

function Protect-CtgSecretsInText {
    # Redact brokered secret VALUES out of free text (a failure message) before it's posted to the
    # app — Job.error is persisted and shown in the run report + ServiceNow work note + audit, and a
    # failing API call can echo a key/token/password in its exception. Only values of secret-named
    # fields are scrubbed, so usernames/servers stay visible for diagnosis.
    # -ExtraValues: additional plaintexts to scrub that aren't brokered fields — e.g. the app-injected
    # config.newPassword/initialPassword of a password-reset/onboard job echoed by a provider error.
    param([string]$Text, [hashtable]$Creds, [string[]]$ExtraValues = @())
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    foreach ($v in $ExtraValues) {
        if ($v -and $v.Length -ge 4 -and $Text.Contains($v)) { $Text = $Text.Replace($v, '***') }
    }
    if ($Creds) {
        foreach ($c in $Creds.Values) {
            if (-not $c -or -not $c.Fields) { continue }
            foreach ($k in @($c.Fields.Keys)) {
                $v = [string]$c.Fields[$k]
                if ($v.Length -lt 4) { continue }
                # (1) name-matched secret fields — widened to catch cert/PEM/JSON/private-key fields
                # (e.g. ServiceAccountJson, CertificateBase64) that the old pass|secret|key|token set missed.
                $named = $k -match '(?i)pass|secret|key|token|credential|json|cert|pem|private|account'
                # (2) any value carrying structural chars (/, +, =, {, ", whitespace) is a base64/JSON/PEM
                # BLOB, never a hostname/username/email — scrub it whatever the field is named, so a secret
                # in an unrecognized field can't ride along. Plain identifiers stay visible for diagnosis.
                $blob = $v.Length -ge 8 -and ($v -match '[^A-Za-z0-9._@\-]')
                if (($named -or $blob) -and $Text.Contains($v)) { $Text = $Text.Replace($v, '***') }
            }
        }
    }
    # Never leak the runner's OWN bearer / per-job progress token into a persisted error.
    $prog = if (Get-Variable -Name CtgProgressToken -Scope Global -ErrorAction SilentlyContinue) { $global:CtgProgressToken } else { $null }
    foreach ($t in @($ApiToken, $prog)) {
        $ts = [string]$t
        if ($ts.Length -ge 4 -and $Text.Contains($ts)) { $Text = $Text.Replace($ts, '***') }
    }
    return $Text
}

function Get-CtgBuildId {
    # This runner's build id = SHA-256 over its own files (raw bytes, ordinal-sorted POSIX relpaths),
    # truncated to 12 hex. EXACTLY the hash the app computes over the bundle it serves (lib/runner/
    # bundle.ts runnerBuildId), so the app can show "up to date" vs "update available" with no version
    # string to bump and no marker file to keep in sync. 'unknown' if anything goes wrong.
    $root = $PSScriptRoot
    # Keep in lockstep with SKIP_DIRS in web/lib/runner/bundle.ts. 'scripts' holds operator/diagnostic
    # helpers that never ship to a deployed runner (and so must not move the build hash).
    $skip = 'tests', 'dist', 'node_modules', 'scripts'
    try {
        # -Force so dot-entries are enumerated on EVERY platform (PowerShell hides them on Unix but not
        # Windows — that divergence is exactly what made a stray .claude/.remember in the bundle loop the
        # Mac agent forever). Then skip any dot-segment + build/test dirs + logs/test files, matching
        # bundle.ts so the runner's self-computed hash equals the app's bundle hash on all platforms.
        $rels = foreach ($f in Get-ChildItem -Force -LiteralPath $root -Recurse -File) {
            $rel = ([System.IO.Path]::GetRelativePath($root, $f.FullName)) -replace '\\', '/'
            if ($rel.Split('/') | Where-Object { $skip -contains $_ -or $_.StartsWith('.') }) { continue }
            if ($f.Name -like '*.Tests.ps1' -or $f.Name -like '*.log') { continue }
            $rel
        }
        $arr = @($rels); [Array]::Sort($arr, [System.StringComparer]::Ordinal)
        $ms = New-Object System.IO.MemoryStream
        foreach ($rel in $arr) {
            $rb = [System.Text.Encoding]::UTF8.GetBytes($rel)
            $cb = [System.IO.File]::ReadAllBytes((Join-Path $root $rel))
            $ms.Write($rb, 0, $rb.Length); $ms.WriteByte(0); $ms.Write($cb, 0, $cb.Length); $ms.WriteByte(0)
        }
        $ms.Position = 0
        $h = [System.Security.Cryptography.SHA256]::HashData($ms)   # static — no disposable instance to leak
        $ms.Dispose()
        return (-join ($h | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
    }
    catch { return 'unknown' }
}

function Invoke-CtgAdDiscovery {
    # Operator clicked "Refresh AD objects": read the DC's OUs + groups (read-only; the agent's own
    # domain context can read the directory — no brokered credential needed) and report them back so
    # the rules editor can offer real OU/group pickers instead of hand-typed DNs.
    if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) { Write-Warning "AD discovery skipped — no ActiveDirectory module on this host"; return }
    try {
        $ous = @(Get-ADOrganizationalUnit -Filter * -ErrorAction Stop | Select-Object -ExpandProperty DistinguishedName)
        $groups = @(Get-ADGroup -Filter * -ErrorAction Stop | Select-Object -ExpandProperty Name)
        Invoke-AppApi POST '/api/agents/ad-objects' @{ agentId = $AgentId; ous = $ous; groups = $groups } | Out-Null
        Write-Host "AD discovery: reported $($ous.Count) OUs, $($groups.Count) groups" -ForegroundColor Green
    }
    catch {
        Write-Warning "AD discovery failed: $($_.Exception.Message)"
    }
}

# Ask the app for a CURRENT one-time password for this job's secret. Delinea holds the authenticator
# seed (one-time-password enabled on the secret) and mints the code; the SEED is never sent to us.
# NOTE: this is the PRE-MINT variant — anything fetched here still has to survive until the consumer
# uses it. Browser flows must NOT use this (browser launch + SSO outlive a 30s code): they get an
# -OtpRequest spec and mint at the MFA prompt instead. Kept for non-browser MFA needs and tests.
function Get-JobOtp {
    param($JobId, $SecretName)
    try {
        $ref = Invoke-AppApi POST "/api/jobs/$JobId/credential" @{ agentId = $AgentId; secretName = $SecretName; otp = $true }
    } catch {
        Write-CtgLog "could not fetch a one-time password from the app: $($_.Exception.Message)" 'WARN'
        return $null
    }
    $code = [string](Get-CtgProp $ref 'otpCode')
    if (-not $code) {
        $why = [string](Get-CtgProp $ref 'otpError')
        if ($why) { Write-CtgLog "no one-time password available: $why" 'WARN' }
        return $null
    }
    [pscustomobject]@{ Code = $code; RemainingSeconds = (Get-CtgProp $ref 'otpRemainingSeconds') }
}

# Field-name SYNONYMS for the two values every brokered credential reduces to.
#
# Delinea templates disagree on what they call the SAME app-registration credential: the "Entra Azure
# AD Account" template stores it as Username/Password, while "Automation - Azure App" stores it as
# appID/Secret (+ tenantID). Both are the client-credentials pair Connect-CtgM365 needs — it connects
# with -ClientSecretCredential, where UserName IS the app id and Password IS the client secret. Reading
# only 'Username'/'Password' handed those clients a $null credential and failed at connect time with an
# opaque bind error, so the broker accepts either spelling.
#
# $fields is a case-INSENSITIVE PowerShell hashtable, so only the SPELLING matters here, not the case
# (that's also why 'tenantID' already satisfies Get-CtgTenantDomain's $s.Fields['TenantId'] lookup).
$script:CRED_USERNAME_FIELDS = @('Username', 'appID', 'AppId', 'ApplicationId', 'ClientId')
$script:CRED_PASSWORD_FIELDS = @('Password', 'Secret', 'ClientSecret', 'AppSecret')

function Select-CtgCredField {
    # First NON-EMPTY value among $Names, or $null. A field that exists but is blank must not win over
    # a later synonym that actually carries the value.
    param([hashtable]$Fields, [string[]]$Names)
    foreach ($n in $Names) {
        if ($Fields.ContainsKey($n)) {
            $v = [string]$Fields[$n]
            if (-not [string]::IsNullOrWhiteSpace($v)) { return $v }
        }
    }
    return $null
}

function Get-JobCredential {
    # Push-down model: ask the app to broker secret $SecretName for this job. The app resolves the
    # VALUE from Delinea and returns the fields (Username/Password/Server/...), so the runner needs
    # no Delinea creds of its own. We rebuild the same shape the executors expect
    # (.Username/.Password/.Credential/.Fields) from those fields.
    param($JobId, $SecretName)
    $ref = Invoke-AppApi POST "/api/jobs/$JobId/credential" @{ agentId = $AgentId; secretName = $SecretName }
    # $ref.fields is a JSON object -> PSCustomObject; flatten to a hashtable.
    $fields = @{}
    if ($ref.fields) { foreach ($p in $ref.fields.PSObject.Properties) { $fields[$p.Name] = $p.Value } }
    # Treat an absent OR empty field set as unresolved — an empty {} is truthy in PS and would
    # otherwise slip through and surface much later as an opaque null-credential bind error.
    if ($fields.Count -eq 0) {
        $why = if ($ref.note) { $ref.note } else { "the app returned no secret fields" }
        throw "secret '$SecretName' was not resolved by the app — $why"
    }
    $username = Select-CtgCredField $fields $script:CRED_USERNAME_FIELDS
    $pw = Select-CtgCredField $fields $script:CRED_PASSWORD_FIELDS
    $password = if ($pw) { ConvertTo-SecureString $pw -AsPlainText -Force } else { $null }
    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
    [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $fields }
}

function Get-ConnTestCredential {
    # Same push-down broker as Get-JobCredential, but for a connection test (no job). Rebuilds the
    # .Username/.Password/.Credential/.Fields shape the $DISPATCH Connect blocks expect.
    param($TestId, $SecretName)
    $ref = Invoke-AppApi POST "/api/runner/conn-tests/$TestId/credential" @{ agentId = $AgentId; secretName = $SecretName }
    $fields = @{}
    if ($ref.fields) { foreach ($p in $ref.fields.PSObject.Properties) { $fields[$p.Name] = $p.Value } }
    if ($fields.Count -eq 0) {
        $why = if ($ref.note) { $ref.note } else { "the app returned no secret fields" }
        throw "secret '$SecretName' was not resolved by the app — $why"
    }
    $username = Select-CtgCredField $fields $script:CRED_USERNAME_FIELDS
    $pw = Select-CtgCredField $fields $script:CRED_PASSWORD_FIELDS
    $password = if ($pw) { ConvertTo-SecureString $pw -AsPlainText -Force } else { $null }
    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
    [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $fields }
}

# Which Graph permissions the M365 onboarder actually exercises, each satisfied by ANY of the listed
# scopes. Compared against the connection's GRANTED scopes (Get-MgContext) so the test can name the
# exact permission someone forgot to grant + admin-consent, instead of a bare "Insufficient privileges".
# One declaration, two consumers: the human gap strings AND the structured rights rows the probe posts.
$script:GRAPH_REQUIRED_CAPS = @(
    @{ need = 'create / update users + assign licenses'; anyOf = @('User.ReadWrite.All', 'Directory.ReadWrite.All') }
    @{ need = 'add users to groups';                      anyOf = @('Group.ReadWrite.All', 'GroupMember.ReadWrite.All', 'Directory.ReadWrite.All') }
    @{ need = 'read licenses / groups (SKUs)';            anyOf = @('Organization.Read.All', 'Directory.Read.All', 'Directory.ReadWrite.All', 'User.Read.All', 'Group.Read.All') }
)
function Get-CtgGraphScopeGaps {
    param([string[]]$Granted)
    $gaps = @()
    foreach ($r in $script:GRAPH_REQUIRED_CAPS) {
        $have = $false
        foreach ($s in $r.anyOf) { if ($Granted -contains $s) { $have = $true; break } }
        if (-not $have) { $gaps += "$($r.need) — grant one of: $($r.anyOf -join ', ')" }
    }
    $gaps
}
# The same requirement map as structured per-operation rows for the conn-test result:
# @{ op; ok ($true/$false/$null = unverifiable); detail }.
function Get-CtgGraphRightsRows {
    param([string[]]$Granted)
    $rows = @()
    foreach ($r in $script:GRAPH_REQUIRED_CAPS) {
        $match = $null
        foreach ($s in $r.anyOf) { if ($Granted -contains $s) { $match = $s; break } }
        $rows += if ($match) { @{ op = [string]$r.need; ok = $true; detail = "granted via $match" } }
                 else        { @{ op = [string]$r.need; ok = $false; detail = "grant one of: $($r.anyOf -join ', ')" } }
    }
    $rows
}

# The app-only blind spot: Get-MgContext.Scopes is EMPTY for client-credentials auth (app perms ride
# the token's `roles` claim, not scopes), so the scope-gap check above can't see what's granted. This
# reads the ACTUAL consented application permissions from the directory: the app's service principal
# appRoleAssignments in THIS tenant, resolved to names (User.ReadWrite.All, …). Uses Invoke-MgGraphRequest
# (ships with the Authentication module — no extra Graph submodule). Returns:
#   @{ ok=$true;  roles=@('User.ReadWrite.All', …) }   when it could read them
#   @{ ok=$false; reason='…' }                          when it couldn't (usually the app lacks
#                                                        Application.Read.All / Directory.Read.All)
function Get-CtgGrantedGraphAppRoles {
    $ctx = Get-MgContext
    if (-not $ctx -or -not $ctx.ClientId) { return @{ ok = $false; reason = 'no Graph context (not connected app-only)' } }
    $appId = [string]$ctx.ClientId
    try {
        $resp = Invoke-MgGraphRequest -Method GET -ErrorAction Stop `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals(appId='$appId')/appRoleAssignments?`$top=200"
    }
    catch {
        return @{ ok = $false; reason = "couldn't read this app's granted application permissions — the app registration likely lacks Application.Read.All or Directory.Read.All (grant one so this check can verify the rest), or verify manually in Entra > App registrations > API permissions. ($([string]$_.Exception.Message))" }
    }
    $assignments = @($resp.value)
    if ($assignments.Count -eq 0) { return @{ ok = $true; roles = @() } } # consented to NOTHING
    $rolesByResource = @{}  # resourceSpId -> @{ appRoleId -> value }
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($a in $assignments) {
        $rid = [string]$a.resourceId
        if (-not $rolesByResource.ContainsKey($rid)) {
            $map = @{}
            try {
                $r = Invoke-MgGraphRequest -Method GET -ErrorAction Stop -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/${rid}?`$select=appRoles"
                foreach ($ar in @($r.appRoles)) { $map[[string]$ar.id] = [string]$ar.value }
            }
            catch { }
            $rolesByResource[$rid] = $map
        }
        $v = $rolesByResource[$rid][[string]$a.appRoleId]
        if ($v) { $names.Add($v) }
    }
    return @{ ok = $true; roles = @($names | Sort-Object -Unique) }
}

# Connection-test probes: after Connect (auth), one cheap authorized READ proves real access — not
# just that the credential authenticates. The m365 probe ALSO diffs the granted Graph scopes against
# what onboarding needs, so a permissions gap is reported by name. Systems with a $DISPATCH Connect
# but no probe here are connect-only. AD/dir-sync have no session Connect, so their probe binds with
# the ad-dc credential. Extend freely — keep reads cheap + read-only.
$CONNTEST_PROBE = @{
    'm365'             = { param($job, $creds)
        $org = $null; try { $org = @(Get-MgOrganization -ErrorAction Stop)[0] } catch { }
        # Show the tenant DISPLAY NAME + its default domain together — the display name (e.g.
        # "Newco, Inc.") often differs from the client name + the domain, which surprises operators.
        $dom = ''
        if ($org -and $org.VerifiedDomains) { $d = @($org.VerifiedDomains | Where-Object { $_.IsDefault }); if ($d.Count) { $dom = [string]$d[0].Name } }
        $base = if ($org) { "tenant: $($org.DisplayName)$(if ($dom) { " ($dom)" })" } else { "connected" }
        # Read the ACTUAL consented application permissions from the directory (app-only doesn't expose
        # them via Get-MgContext.Scopes). Falls back to delegated scopes if that's how we're connected.
        $granted = @(); $how = ''
        $real = Get-CtgGrantedGraphAppRoles
        if ($real.ok) { $granted = @($real.roles); $how = 'application permissions (consented in this tenant)' }
        else {
            $ctx = Get-MgContext
            if ($ctx -and $ctx.Scopes) { $granted = @($ctx.Scopes); $how = 'delegated scopes' }
        }
        if ($granted.Count -eq 0 -and -not $real.ok) {
            $script:ConnTestRights = @(@{ op = 'verify Graph permissions'; ok = $null; detail = [string]$real.reason })
            return "$base · connected, but couldn't verify permissions: $($real.reason)"
        }
        $script:ConnTestRights = @(Get-CtgGraphRightsRows $granted)
        # Warn before the app's own secret/cert expires (best-effort; needs Application.Read.All).
        try { $exp = Get-CtgAppCredentialExpiry; if ($exp -and $exp.expiresAt) { $script:ConnTestCredExpiresAt = [string]$exp.expiresAt } } catch { }
        $gaps = Get-CtgGraphScopeGaps $granted
        if ($gaps.Count) {
            throw "$base · consented ${how}: [$(@($granted) -join ', ')] — but MISSING: $($gaps -join ' || '). Add these as APPLICATION permissions on the app registration and grant admin consent IN THIS TENANT, then re-test."
        }
        "$base · all required Graph permissions present — ${how}: $(@($granted) -join ', ')"
    }
    'exchange'         = { param($job, $creds) $o = Get-OrganizationConfig -ErrorAction Stop; "org: $($o.Name)" }
    'mimecast'         = { param($job, $creds)
        # Probe the actual operations onboarding needs and report which the API 2.0 app is permitted
        # to do — so "Test connections" shows the app's real permission map (Mimecast has no API to
        # list an app's granted permissions; this infers them from what works). Each op is also
        # posted as a structured rights row.
        $ops = [System.Collections.Generic.List[hashtable]]::new()
        $try = {
            param($label, $path)
            try { Invoke-CtgMimecastApi -Path $path | Out-Null; @{ op = $label; ok = $true; detail = 'allowed' } }
            catch {
                if ([string]$_.Exception.Message -match 'forbidden|not .{0,6}permitted|denied|unauthoriz|\b403\b') { @{ op = $label; ok = $false; detail = 'FORBIDDEN — grant it on the API 2.0 app' } }
                else { @{ op = $label; ok = $null; detail = "error: $(([string]$_.Exception.Message).Substring(0, [Math]::Min(120, ([string]$_.Exception.Message).Length)))" } }
            }
        }
        $ops.Add((& $try 'account read'           '/api/account/get-account'))
        $ops.Add((& $try 'directory/domains read' '/api/domain/get-internal-domain'))
        $ops.Add((& $try 'directory-sync read'    '/api/directory/get-connection'))
        # USER read is what onboarding actually needs (get-profile). Probe a benign address in an
        # internal domain: FORBIDDEN = the missing permission; not-found = the permission IS granted.
        $dom = $null
        try { $idr = @(Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain'); $dom = @($idr | ForEach-Object { $d = Get-CtgProp $_ 'domain'; if (-not $d) { $d = Get-CtgProp $_ 'domainName' }; $d } | Where-Object { $_ })[0] } catch { }
        if ($dom) {
            try {
                $resp = Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{ emailAddress = "postmaster@$dom" } -AllowFail
                $codes = @(@(Get-CtgProp $resp 'fail') | ForEach-Object { @(Get-CtgProp $_ 'errors') | ForEach-Object { [string](Get-CtgProp $_ 'code') } })
                if (($codes -join ' ') -match 'forbidden|operation_forbidden') { $ops.Add(@{ op = 'user read (get-profile)'; ok = $false; detail = 'FORBIDDEN — THIS is the onboarding gap' }) }
                else { $ops.Add(@{ op = 'user read (get-profile)'; ok = $true; detail = 'allowed' }) }
            } catch { $ops.Add(@{ op = 'user read (get-profile)'; ok = $null; detail = 'error probing' }) }
        }
        $script:ConnTestRights = @($ops)
        $report = @($ops | ForEach-Object { "$($_.op): $(if ($_.ok -eq $true) { 'allowed' } elseif ($_.ok -eq $false) { 'FORBIDDEN' } else { 'error' })" })
        $detail = "app permissions -> $($report -join ' | ')"
        # Fail the test (visibly red) when a permission onboarding needs is missing.
        if (@($ops | Where-Object { $_.ok -eq $false }).Count) { throw $detail }
        $detail
    }
    'active-directory' = { param($job, $creds)
        $c = New-CtgAdConnection $creds; $d = Get-ADDomain @c -ErrorAction Stop
        # Rights: can the service account CREATE USERS in the OUs this client's config targets?
        # Evaluated from the OU ACLs (read-only) via the pure helper in Coretelligent.ActiveDirectory;
        # anything unreadable degrades to "verify manually", never a false failure.
        $ous = @()
        foreach ($pair in @(@('onboard', 'ou'), @('offboard', 'moveToOu'), @('offboard', 'disabledUsersOu'))) {
            $lane = Get-CtgProp $job.config $pair[0]
            $v = if ($lane) { [string](Get-CtgProp $lane $pair[1]) } else { $null }
            if ($v -and $v -match '(?i)dc=') { $ous += $v }
        }
        $ous = @($ous | Select-Object -Unique)
        if ($ous.Count) {
            $sids = Get-CtgAdAccountSids -AdConnection $c -Creds $creds
            $rows = @()
            foreach ($ou in $ous) {
                $rows += Test-CtgAdOuCreateUserRight -AdConnection $c -OuDn $ou -Sids $sids
            }
            $script:ConnTestRights = @($rows)
            $denied = @($rows | Where-Object { $_.ok -eq $false })
            if ($denied.Count) { throw "domain: $($d.DNSRoot) — the account cannot create users in: $(@($denied | ForEach-Object { $_.op }) -join '; ')" }
        }
        else {
            $script:ConnTestRights = @(@{ op = 'create users in target OU'; ok = $null; detail = 'no OU DN in this client''s config — set onboard.ou to verify the ACL' })
        }
        "domain: $($d.DNSRoot)"
    }
    'directory-sync'   = { param($job, $creds) $c = New-CtgAdConnection $creds; $d = Get-ADDomain @c -ErrorAction Stop; "AD reachable: $($d.DNSRoot)" }
}
$CONNTEST_PROBE['entra'] = $CONNTEST_PROBE['m365']  # entra is the M365 module's Entra slice — same Graph perms
# Cloud REST systems: after Connect (above), do one read so the test validates the credential +
# read scope against the live API (not just that Connect assembled an auth header).
$CONNTEST_PROBE['zoom']        = { param($job, $creds)
    Invoke-CtgZoomApi -Method GET -Path '/users?page_size=1' | Out-Null
    # The S2S token response names the app's granted scopes (Connect captures them) — compare
    # against what the on/offboarders actually call: user reads, user writes (create/update/
    # deactivate), and — only when the client's config assigns phone — phone writes.
    $scopes = @(Get-CtgZoomGrantedScopes)
    if ($scopes.Count -eq 0) {
        $script:ConnTestRights = @(@{ op = 'verify Zoom scopes'; ok = $null; detail = 'token response carried no scope list — verify the S2S app scopes in the Zoom marketplace' })
        return 'zoom: users readable'
    }
    $capOf = { param($label, $pattern, $hint)
        if (@($scopes | Where-Object { $_ -match $pattern }).Count) { @{ op = $label; ok = $true; detail = "granted ($(@($scopes | Where-Object { $_ -match $pattern }) -join ', '))" } }
        else { @{ op = $label; ok = $false; detail = $hint } }
    }
    $rows = @(
        (& $capOf 'read users'                  '^user:read'   'grant user:read:admin (or the granular read scopes) on the S2S app')
        (& $capOf 'create / update / deactivate users' '^user:write' 'grant user:write:admin (or the granular write scopes) on the S2S app')
    )
    $wantsPhone = $false
    foreach ($lane in @('onboard', 'offboard')) { $c = Get-CtgProp $job.config $lane; if ($c -and (Get-CtgProp $c 'phone')) { $wantsPhone = $true } }
    if ($wantsPhone) { $rows += (& $capOf 'assign phone' '^phone:write' 'grant phone:write:admin — this client''s config assigns Zoom Phone') }
    $script:ConnTestRights = @($rows)
    $missing = @($rows | Where-Object { $_.ok -eq $false })
    if ($missing.Count) { throw "zoom: users readable, but the S2S app is missing scopes -> $(@($missing | ForEach-Object { $_.op }) -join ', '). $(@($missing | ForEach-Object { $_.detail }) -join ' | ')" }
    "zoom: users readable — scopes cover $(@($rows | ForEach-Object { $_.op }) -join ', ')"
}
$CONNTEST_PROBE['sentinelone'] = { param($job, $creds)
    Invoke-CtgSentinelOneApi -Method GET -Path '/web/api/v2.1/agents?limit=1' | Out-Null
    # Offboarding needs more than a read: try to name the API token's role. S1 has no clean
    # "what can I do" endpoint, so an unreadable role is reported as unverifiable, not a failure.
    $role = $null
    try { $me = Invoke-CtgSentinelOneApi -Method GET -Path '/web/api/v2.1/user'; $role = [string](Get-CtgProp (Get-CtgProp $me 'data') 'scopeRoles') } catch { }
    $roleDetail = if ($role) { "API user roles: $role — confirm they allow agent actions" } else { 'no role introspection API — verify the token''s role allows agent actions' }
    $script:ConnTestRights = @(@{ op = 'agent actions (offboard disconnect/shutdown)'; ok = $null; detail = $roleDetail })
    'sentinelone: agents readable'
}
$CONNTEST_PROBE['xmatters']    = { param($job, $creds)
    Invoke-CtgXMattersApi -Method GET -Path '/people?limit=1' | Out-Null
    $script:ConnTestRights = @(@{ op = 'create / delete people'; ok = $null; detail = 'xMatters has no permission introspection — verify the API user has the "REST Web Service User" role' })
    'xmatters: people readable'
}
# Google Workspace: domain-wide-delegation token minting is all-or-nothing — the exchange itself
# fails (unauthorized_client) if ANY requested scope isn't authorized for the service account's
# client ID. So a successful Connect PROVES every requested scope; one live read then proves the
# impersonated admin works. That turns the token grant into a real per-scope rights check.
$CONNTEST_PROBE['google-workspace'] = { param($job, $creds)
    $resp = Invoke-CtgGoogleApi -Method GET -Path "/users?customer=$script:GoogleCustomer&maxResults=1"
    $scopes = @(Get-CtgGoogleSessionScopes)
    $script:ConnTestRights = @($scopes | ForEach-Object {
        @{ op = "scope $((($_ -split '/')[-1]))"; ok = $true; detail = 'authorized via domain-wide delegation (token minted with this scope)' }
    })
    # Connect-CtgGoogle ASKS for admin.directory.user.security and falls back without it, so a
    # connected session does NOT imply the domain authorized it. Report its absence explicitly —
    # otherwise every scope row is green while offboarding silently cannot revoke a leaver's
    # sessions/refresh tokens, and the operator has no way to see that from here.
    $securityScope = 'https://www.googleapis.com/auth/admin.directory.user.security'
    if ($scopes.Count -and ($scopes -notcontains $securityScope)) {
        $script:ConnTestRights += @{
            op = 'scope admin.directory.user.security'; ok = $false
            detail = 'NOT authorized — offboarding cannot sign a leaver out (their sessions and refresh tokens survive the suspend). Add this scope in Admin Console -> Security -> API controls -> Domain-wide delegation.'
        }
    }
    if ($scopes.Count -eq 0) { $script:ConnTestRights = @(@{ op = 'verify delegation scopes'; ok = $null; detail = 'session did not record its scopes (token passed directly?)' }) }
    "google: users readable (delegation scopes verified: $($scopes.Count))"
}
# Spanning has NO Connect in $DISPATCH (Connect-CtgSpanning is a pure local assignment), so the probe
# reads the brokered secret itself (Use-CtgSpanningSecret) then does one live LIST read. The /users
# LIST route is the VERIFIED one (the /users/{email} route 400s on some tenants), so listing a single
# user proves the Basic clientId:clientSecret actually authorizes a read against the live API.
$CONNTEST_PROBE['spanning']    = { param($job, $creds)
    Use-CtgSpanningSecret $job $creds
    $resp  = Invoke-CtgSpanningApi -Method GET -Path '/users?size=1'
    $users = Get-CtgProp $resp 'users'; if ($null -eq $users) { $users = Get-CtgProp $resp 'items' }; if ($null -eq $users) { $users = $resp }
    # Rights: license assign/unassign is the only WRITE onboarding does. Probe authz without
    # touching a user — an EMPTY userPrincipalNames list either 400s (validation ran => the request
    # passed authn/authz) or no-ops; a 401/403 means the token can't assign. NEVER send a real UPN.
    $assign = try {
        Invoke-CtgSpanningApi -Method POST -Path '/users/assign' -Body @{ userPrincipalNames = @(); licenseType = 'STANDARD' } | Out-Null
        @{ op = 'license assign/unassign'; ok = $true; detail = 'authorized (empty-list probe accepted)' }
    } catch {
        $m = [string]$_.Exception.Message
        if ($m -match 'HTTP 400')            { @{ op = 'license assign/unassign'; ok = $true;  detail = 'authorized (empty-list probe reached validation)' } }
        elseif ($m -match 'HTTP 40[13]')     { @{ op = 'license assign/unassign'; ok = $false; detail = 'token cannot assign licenses (401/403) — generate the API token as a Spanning admin' } }
        else                                 { @{ op = 'license assign/unassign'; ok = $null;  detail = 'cannot verify without licensing a user — verify manually' } }
    }
    $script:ConnTestRights = @(@{ op = 'read users'; ok = $true; detail = 'list read works' }, $assign)
    if ($assign.ok -eq $false) { throw "spanning: users readable, but $($assign.detail)" }
    "spanning: users readable (sample returned $(@($users).Count))"
}
# Proofpoint Essentials: read the org's Azure sync settings (also proves the X-User/X-Password admin
# auth + org-path domain). Reports whether sync is on, its frequency, and the last successful sync —
# the same signal the onboarding lane uses to decide "wait for the next sync" vs. "sync isn't enabled".
$CONNTEST_PROBE['proofpoint']  = { param($job, $creds)
    Use-CtgProofpointSecret $job $creds
    $az = Get-CtgProofpointAzureSync
    if ($null -eq $az) { return 'proofpoint: connected (admin auth OK) — but Azure/Entra sync is not configured for this org' }
    $freq = Get-CtgProp $az 'sync_frequency'; $last = Get-CtgProp $az 'last_successful_sync'
    $script:ConnTestRights = @(@{ op = 'user create / deactivate'; ok = $null; detail = 'Proofpoint has no permission introspection — verify the API account''s admin role allows user management' })
    "proofpoint: connected — Azure sync $(if ($freq -and "$freq" -ne '0') { "on (every ${freq}h)" } else { 'OFF' })$(if ($last) { ", last sync $last" })"
}
# 1Password: only the api method has a credential to test — prove the admin `op` sign-in works + can
# read users. scim/manual/browser have no app credential, so report that there's nothing to probe.
$CONNTEST_PROBE['1password']   = { param($job, $creds)
    $method = ([string](Get-CtgProp $job.config 'method')); if (-not $method) { $method = 'auto' }
    if ($method -in @('scim', 'manual', 'browser')) { return "1password: method '$method' uses no API credential — nothing to test (provisioning is $(if ($method -eq 'scim') { 'IdP/SCIM-driven' } else { 'manual' }))" }
    Use-Ctg1PasswordSecret -Job $job -Creds $creds
    $who = Invoke-Ctg1PasswordCli -OpArgs @('whoami') -AllowFail
    Invoke-Ctg1PasswordCli -OpArgs @('user', 'list') -AllowFail | Out-Null
    $script:ConnTestRights = @(@{ op = 'provision / suspend users'; ok = $null; detail = '1Password has no permission introspection — verify the account is in the Provision Managers group (or is an owner/admin)' })
    "1password: signed in + users readable$(if ($who) { " (as $([string](Get-CtgProp $who 'email')))" })"
}

function Invoke-CtgConnectionTests {
    # Claim + run any queued connection tests for this agent. Fully isolated from the job pipeline:
    # connect with the brokered credential, run the read probe, report pass/fail + a one-line detail.
    $tests = @()
    try { $tests = Invoke-AppApi POST '/api/runner/conn-tests/claim' @{ agentId = $AgentId; max = 5 } } catch { return }
    # Flatten an exception chain to a one-line, secret-redacted message.
    $errLine = { param($e, $c) $ex = $e.Exception; $ch = [System.Collections.Generic.List[string]]::new(); while ($ex) { if ($ex.Message) { [void]$ch.Add($ex.Message) }; $ex = $ex.InnerException }; Protect-CtgSecretsInText (($ch | Select-Object -Unique) -join ' <- ') $c }
    foreach ($t in @($tests)) {
        $global:CtgProgressJobId = $null   # no job -> keep Connect's Set-CtgPhase from posting progress
        # TWO STAGES, reported separately: (1) ACCESS — can the runner resolve the secret(s) from the
        # app/Delinea; (2) API — connect + one live read against the vendor. A failed access skips API.
        $accessOk = $true; $accessDetail = ''
        $apiOk = $true; $apiDetail = ''
        $creds = @{}
        # Probes may fill this with per-operation rights rows (@{ op; ok; detail }); it survives a
        # probe THROW so a definite permission gap still reports which ops passed/failed.
        $script:ConnTestRights = $null
        $script:ConnTestCredExpiresAt = $null   # a probe may set the credential's own expiry (ISO)
        # Pass the system's config so a Connect that reads it (e.g. exchange's onPremExchangeUri) works
        # in the test. It's the whole ClientSystem.config (onboard/offboard sub-objects), not a lane.
        $job = [pscustomobject]@{ id = ''; systemKey = $t.systemKey; action = 'onboard'; config = $t.config; client = [pscustomobject]@{ slug = $t.clientSlug; primaryDomain = $t.primaryDomain } }

        try {
            $names = @(@($t.secretNames) | Where-Object { $_ })
            foreach ($sn in $names) { $creds[$sn] = Get-ConnTestCredential $t.id $sn }
            $accessDetail = if ($names.Count) { "resolved $($names.Count) secret$(if ($names.Count -ne 1) { 's' }): $($names -join ', ')" } else { 'no secret required' }
        }
        catch {
            $accessOk = $false; $accessDetail = & $errLine $_ $creds
            $apiOk = $false; $apiDetail = 'skipped — secret not resolved from Delinea'
        }

        if ($accessOk) {
            try {
                $handler = $DISPATCH[$t.systemKey]
                $probe = $CONNTEST_PROBE[$t.systemKey]
                $hasConnect = $handler -and $handler.ContainsKey('Connect')
                if (-not $hasConnect -and -not $probe) { throw "no automated connection test available for '$($t.systemKey)' — verify it manually" }
                if ($hasConnect) { & $handler.Connect $job $creds; $apiDetail = 'connected' }
                if ($probe) { $apiDetail = & $probe $job $creds }
            }
            catch { $apiOk = $false; $apiDetail = & $errLine $_ $creds }
            finally {
                # A conn-test connects OUTSIDE the cached-connection path — drop this system's cache key
                # so the next REAL job reconnects with its own tenant/creds (never reuses this session).
                # Siblings too: an m365 conn-test rebinds the one Graph session that entra/tap/notify/
                # m365-password-reset also ride, so their cache keys are stale as well.
                Clear-CtgConnectionSiblings -SystemKey $t.systemKey -IncludeSelf
            }
        }
        $body = @{ agentId = $AgentId; accessOk = $accessOk; accessDetail = "$accessDetail"; ok = $apiOk; detail = "$apiDetail" }
        if ($script:ConnTestRights) {
            # Scrub each row's detail like the top-level details — never a secret in a rights row.
            $body.rights = @($script:ConnTestRights | ForEach-Object {
                @{ op = [string]$_.op; ok = $_.ok; detail = Protect-CtgSecretsInText ([string]$_.detail) $creds }
            })
        }
        if ($script:ConnTestCredExpiresAt) { $body.credExpiresAt = [string]$script:ConnTestCredExpiresAt }
        $script:ConnTestRights = $null
        $script:ConnTestCredExpiresAt = $null
        try { $null = Invoke-AppApi POST "/api/runner/conn-tests/$($t.id)/result" $body } catch { }
    }
}

function Invoke-CtgCloudGroupDiscovery {
    # Central runner only (the claim endpoint returns nothing to client agents). For each client that
    # requested it, connect to M365 with the brokered m365 secret and read the tenant's groups, tagged
    # DL / Security / M365 Group, so the app's pickers can offer cloud groups AD sync never covers.
    $work = @()
    try { $work = Invoke-AppApi POST '/api/runner/cloud-groups/claim' @{ agentId = $AgentId } } catch { return }
    foreach ($w in @($work)) {
        $global:CtgProgressJobId = $null
        try {
            # Rebuild $creds from the pushed fields (push-down model — no Delinea creds on the runner).
            $creds = @{}
            if ($w.creds) {
                foreach ($p in $w.creds.PSObject.Properties) {
                    $f = @{}
                    if ($p.Value.fields) { foreach ($q in $p.Value.fields.PSObject.Properties) { $f[$q.Name] = $q.Value } }
                    $username = Select-CtgCredField $f $script:CRED_USERNAME_FIELDS
                    $pw = Select-CtgCredField $f $script:CRED_PASSWORD_FIELDS
                    $password = if ($pw) { ConvertTo-SecureString $pw -AsPlainText -Force } else { $null }
                    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
                    $creds[$p.Name] = [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $f }
                }
            }
            $job = [pscustomobject]@{ id = ''; systemKey = 'm365'; client = [pscustomobject]@{ slug = $w.clientSlug; primaryDomain = $w.primaryDomain } }
            & $DISPATCH['m365'].Connect $job $creds
            # Don't let a real job reuse this connection — and not just an m365 job: this Connect bound
            # the shared Graph session, so entra/tap/notify/m365-password-reset are stale too.
            Clear-CtgConnectionSiblings -SystemKey 'm365' -IncludeSelf
            $groups = @()
            foreach ($g in (Get-MgGroup -All -Property 'DisplayName,GroupTypes,MailEnabled,SecurityEnabled' -ErrorAction Stop)) {
                $type = if ($g.GroupTypes -contains 'Unified') { 'm365' }
                        elseif ($g.MailEnabled -and -not $g.SecurityEnabled) { 'dl' }
                        else { 'security' }
                if ($g.DisplayName) { $groups += @{ name = [string]$g.DisplayName; type = $type } }
            }
            $null = Invoke-AppApi POST '/api/runner/cloud-groups/result' @{ agentId = $AgentId; clientSlug = $w.clientSlug; groups = $groups }
            Write-Host "  cloud groups: reported $($groups.Count) for $($w.clientSlug)" -ForegroundColor Green
        } catch {
            Write-Warning "cloud group discovery failed for $($w.clientSlug): $($_.Exception.Message)"
        }
    }
}

# Build id of the code we're actually running = hash of our own files (matches the app's hash of the
# bundle it serves). Reported on every heartbeat → accurate even if a past restart half-landed, with
# no marker file to keep in sync.
$script:RunnerBuild = Get-CtgBuildId

# Human-readable release version from VERSION (e.g. "1.0.0"), reported alongside the build id so the
# Agents page can show "v1.0.0 · build <hash>". Display only — the hash stays the up-to-date check.
$script:RunnerSemver = try { (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw -ErrorAction Stop).Trim() } catch { $null }

# This process's start time (ISO-8601 UTC), reported on every heartbeat so the Agents page can show
# UPTIME (now - bootAt). Re-exec on update/restart is a new process, so uptime correctly resets then.
$script:RunnerStartedAt = (Get-Date).ToUniversalTime().ToString("o")

# On-prem CAPABILITY probe: which ALWAYS_ON_PREM system keys THIS host can actually execute — i.e. the
# host-specific Coretelligent entry function is loaded (its dependency module imported above). Reported
# each heartbeat so the app WITHHOLDS on-prem jobs from agents that can't run them (they stay pending
# with a clear reason) instead of dispatching a step that hard-fails with "module not loaded". Extend
# this map when a new ALWAYS_ON_PREM system is added. (directory-sync's module loads unconditionally and
# remotes to the sync host, so it's ~always capable; active-directory needs the ActiveDirectory module.)
$script:OnPremCapabilityProbe = [ordered]@{
    'active-directory' = 'Invoke-CtgADOnboarding'
    'directory-sync'   = 'Invoke-CtgDirectorySync'
}
$script:RunnerCapabilities = @(
    $script:OnPremCapabilityProbe.Keys | Where-Object { Get-Command $script:OnPremCapabilityProbe[$_] -ErrorAction SilentlyContinue }
)
# Self-heal the browser sidecar ONCE at startup (mirrors the RSAT block above). Capabilities are
# computed here, once per process, and the claim gate WITHHOLDS browser jobs from agents not reporting
# 'browser' — so a lazy first-use install could never happen (the agent would never receive the job).
# The install (npm install + a ~170MB Chromium download) MUST NOT run inline: it takes minutes on a
# cold host and, on one with no egress to npmjs.org / the Playwright CDN, blocks until its timeout.
# Inline, that delays the FIRST heartbeat — the agent goes silent, the app shows it stuck "updating",
# and an operator debugs a phantom install/auth problem. So: kick it off in the BACKGROUND, heartbeat
# immediately, and start advertising 'browser' on a later beat once it finishes (the poll loop's
# capability refresh below). Opt out with IAM_RUNNER_NO_BROWSER_INSTALL=1 — the installer sets that
# for client-network agents, which have no business running headless Chromium on a DC.
$script:BrowserInstallJob = $null
if ($env:IAM_RUNNER_NO_BROWSER_INSTALL -eq '1') {
    Write-Host "Browser sidecar: install disabled (IAM_RUNNER_NO_BROWSER_INSTALL=1) — browser jobs are withheld from this agent." -ForegroundColor DarkGray
}
elseif (-not (Test-CtgBrowserAvailable) -and (Resolve-CtgNodeTool 'node')) {
    Write-Host "Browser sidecar not fully installed — installing Playwright + Chromium in the BACKGROUND (the runner keeps polling)…" -ForegroundColor Yellow
    try {
        $script:BrowserModulePath = (Get-Module Coretelligent.Browser).Path
        $script:BrowserInstallJob = Start-Job -Name 'ctg-browser-install' -ScriptBlock {
            param($m)
            Import-Module $m -Force
            [bool](Install-CtgBrowser)
        } -ArgumentList $script:BrowserModulePath
    } catch {
        Write-Warning "browser sidecar: could not start the background install: $($_.Exception.Message) — browser jobs will be withheld"
    }
}
# Browser automation is a CROSS-CUTTING capability (not an on-prem system): report 'browser' when the
# Node/Playwright sidecar is installed on this host, so the app's claim gate hands browser jobs (e.g.
# spanning-force-sync) only to agents that can actually run them. The server ignores 'browser' in the
# on-prem exclusion (it's not in ALWAYS_ON_PREM_SYSTEMS) and keys the separate browser gate off it.
if (Test-CtgBrowserAvailable) { $script:RunnerCapabilities += 'browser' }
# Serialize as a JSON-array STRING so 0- and 1-element lists stay arrays over the wire — a bare
# @('active-directory') would ConvertTo-Json to a scalar and @() would pipe nothing (empty output),
# making the server unable to tell "reported, none" (withhold all on-prem) from "legacy runner, not
# reported" (allow, old behavior). Empty is forced to the literal '[]' (an empty pipe emits nothing).
$script:RunnerCapabilitiesJson = if ($script:RunnerCapabilities.Count -eq 0) { '[]' } else { ($script:RunnerCapabilities | ConvertTo-Json -Compress -AsArray) }
Write-Host "on-prem capabilities: $script:RunnerCapabilitiesJson" -ForegroundColor DarkGray

# Single-instance guard. The newest runner process for this folder claims .runner.lock with its PID
# at startup; an OLDER process (e.g. one a half-landed self-update failed to replace) sees a different
# PID on its next loop and exits. Without this, a stale process keeps claiming jobs with OLD in-memory
# modules while a newer process reports the new build — "agent up to date but running old code", which
# silently ran outdated executors after an update. Lock I/O is best-effort (never fatal).
$script:LockPath = Join-Path $PSScriptRoot '.runner.lock'
try { [System.IO.File]::WriteAllText($script:LockPath, [string]$PID) } catch { }

Write-Host "iam-engine runner $AgentId (build $script:RunnerBuild, pid $PID) polling $AppUrl every ${PollSeconds}s" -ForegroundColor Cyan
# Per-process progress globals, read by Send-CtgProgress (callable from the Coretelligent.* modules).
$global:CtgProgressUrl   = $AppUrl
$global:CtgProgressToken = $ApiToken
$global:CtgProgressAgent = $AgentId

# Arm the stall watchdog (lib/Coretelligent.Watchdog) on its own thread: if no progress for
# $StallTimeoutSeconds it self-respawns + hard-exits, recovering from a hung inline job the main loop
# can't escape. Build the same relaunch spec the self-update uses (cross-platform Start-Process).
Update-CtgHeartbeat -Path $global:CtgHeartbeatFile -Phase 'starting'
$wdPwsh = (Get-Process -Id $PID).Path
if (-not $wdPwsh) { $wdPwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
$wdSelf = Join-Path $PSScriptRoot 'Start-IamRunner.ps1'
$wdArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wdSelf,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion)
if ($ApiToken) { $wdArgs += @('-ApiToken',$ApiToken) }
$script:Watchdog = Start-CtgWatchdog -HeartbeatFile $global:CtgHeartbeatFile -TimeoutSeconds $StallTimeoutSeconds -PwshPath $wdPwsh -RelaunchArgs $wdArgs
Write-Host "watchdog armed: restart if no progress for ${StallTimeoutSeconds}s (heartbeat $global:CtgHeartbeatFile)" -ForegroundColor DarkGray

while ($true) {
    # Liveness tick: the loop is alive (idle or between jobs). A long job keeps this fresh via
    # Send-CtgProgress; only a TRUE hang (no progress) lets it go stale and trips the watchdog.
    Update-CtgHeartbeat -Path $global:CtgHeartbeatFile -Phase 'polling'
    $jobs = @()   # reset BEFORE try: a heartbeat/claim throw must not leave a stale value driving the drain check below
    # Superseded by a newer instance? It overwrote .runner.lock with its PID at startup. Exit so this
    # (older) process stops heartbeating + claiming jobs with stale modules. Best-effort; on any lock
    # read error we just continue (fail open — better to keep running than to wrongly self-terminate).
    try {
        if (Test-Path -LiteralPath $script:LockPath) {
            $owner = ([System.IO.File]::ReadAllText($script:LockPath)).Trim()
            if ($owner -and $owner -ne [string]$PID) {
                Write-Warning "a newer runner instance (pid $owner) has taken over; exiting this one (pid $PID)."
                exit 0
            }
        }
    } catch { }
    # Capability refresh: the browser sidecar installs in the BACKGROUND (see startup), so 'browser'
    # isn't known at first heartbeat. When that job finishes, re-probe once and fold the capability in
    # so the NEXT heartbeat advertises it and the app's gate starts routing browser jobs here.
    if ($script:BrowserInstallJob) {
        $st = $script:BrowserInstallJob.State
        if ($st -in @('Completed', 'Failed', 'Stopped')) {
            try { Receive-Job -Job $script:BrowserInstallJob -ErrorAction SilentlyContinue | Out-Null } catch { }
            try { Remove-Job -Job $script:BrowserInstallJob -Force -ErrorAction SilentlyContinue } catch { }
            $script:BrowserInstallJob = $null
            if (Test-CtgBrowserAvailable) {
                if ($script:RunnerCapabilities -notcontains 'browser') { $script:RunnerCapabilities += 'browser' }
                $script:RunnerCapabilitiesJson = ($script:RunnerCapabilities | ConvertTo-Json -Compress -AsArray)
                Write-Host "Browser sidecar ready — now advertising 'browser' ($script:RunnerCapabilitiesJson)" -ForegroundColor Green
            } else {
                Write-Warning "browser sidecar install did not complete (no egress to npmjs.org / the Playwright CDN?) — browser jobs stay withheld from this agent. Set IAM_RUNNER_NO_BROWSER_INSTALL=1 to stop retrying."
            }
        }
    }
    try {
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; version = $script:RunnerBuild; semver = $script:RunnerSemver; startedAt = $script:RunnerStartedAt; capabilities = $script:RunnerCapabilitiesJson }
        if ($hb.enabled -eq $false) { Write-Warning "agent disabled server-side; stopping."; break }
        if ($hb.update -eq $true) { Update-CtgRunner }  # operator requested self-update — re-pull + restart (never returns)
        if ($hb.restart -eq $true) { Restart-CtgRunner }  # operator requested a plain restart — re-exec (never returns)
        if ($hb.discover -eq $true) { Invoke-CtgAdDiscovery }  # operator requested AD OU/group discovery
        # Send our build id so the app refuses to dispatch to a STALE runner (a half-landed update can
        # leave an old process alive; this stops it claiming jobs with old modules in memory).
        $jobs = Invoke-AppApi POST '/api/jobs/claim' @{ agentId = $AgentId; batchSize = $BatchSize; version = $script:RunnerBuild }

        foreach ($job in @($jobs)) {
            $creds = @{}  # in scope for the catch's secret-scrub even if broking/execution throws early
            $script:Phase = 'starting'  # what we're doing now — the catch reports WHICH phase failed
            $global:CtgProgressJobId = $job.id  # so module-level Send-CtgProgress targets this job
            # Header line so the console shows WHICH CASE this job is for (not just the opaque job id).
            $caseNo = if ($job.PSObject.Properties['caseNumber'] -and $job.caseNumber) { [string]$job.caseNumber } else { '(no case #)' }
            Write-Host "[$caseNo] $($job.action) $($job.systemKey)  (job $($job.id))" -ForegroundColor Cyan
            # A system with no per-user config (mimecast, spanning, …) is planned with config=null; the
            # executors take a [Mandatory] -Config, which a null fails to bind ("Cannot bind argument to
            # parameter 'Config' because it is null"). Normalize to an empty object — Get-CtgProp on it
            # just returns null for absent keys, so base onboarding runs.
            if ($null -eq $job.config) { $job.config = [pscustomobject]@{} }
            try {
                $handler = $DISPATCH[$job.systemKey]
                if (-not $handler) {
                    # No executor for this system: resolve as a manual follow-up, not a failure,
                    # so an uncovered `api` system doesn't kill the whole case.
                    $null = Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no executor for $($job.systemKey) — manual follow-up" }
                    continue
                }
                $fn = if ($job.action -eq 'offboard') { $handler.Offboard } else { $handler.Onboard }
                if (-not $fn) {
                    $null = Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no $($job.action) lane for $($job.systemKey) — manual follow-up" }
                    continue
                }

                # First thing the operator sees for this step — it has started.
                Set-CtgPhase $job.id "starting $($job.action) $($job.systemKey)"

                # Broker every secret the job names (least-privilege, one call each), keyed by name.
                Set-CtgPhase $job.id 'brokering credentials'
                foreach ($sn in @($job.secretNames)) { if ($sn) { $creds[$sn] = Get-JobCredential $job.id $sn } }

                # Connect before the first job for this system, and RE-connect whenever the job's
                # tenant OR its brokered credentials differ from what the module is currently
                # connected with (modules hold one connection; see $script:ConnectedTenant). The key
                # includes a fingerprint of the brokered secret fields so that (a) two clients that
                # both lack a primaryDomain but carry different secret TenantIds can NEVER share a
                # connection (the raw-domain key would collide on ''), and (b) rotating a credential
                # in Delinea reconnects on the very next job — no runner restart. Record the key ONLY
                # after Connect succeeds — a throw here (bad cred, unreachable on-prem Exchange,
                # transient) must NOT poison the cache, or every later job in this long-lived process
                # would skip Connect and run unconnected (e.g. "Get-RemoteMailbox not recognized").
                if ($handler.ContainsKey('Connect')) {
                    $tenant = if ($job.client) { $job.client.primaryDomain } else { '' }
                    $connectKey = "$tenant|$(Get-CtgCredFingerprint $creds)"
                    if ($script:ConnectedTenant[$job.systemKey] -ne $connectKey) {
                        Set-CtgPhase $job.id "connecting to $($job.systemKey)"
                        & $handler.Connect $job $creds
                        $script:ConnectedTenant[$job.systemKey] = $connectKey
                        # This Connect just rebound any session shared with sibling keys (Graph/Google),
                        # so their cached keys no longer describe the live connection — drop them or the
                        # next sibling job skips Connect and runs against THIS job's tenant.
                        Clear-CtgConnectionSiblings -SystemKey $job.systemKey
                    }
                }

                # Verify pass: run ONLY the read-only validator (Confirm-Ctg*), no executor/mutation.
                if ([bool]$job.validateOnly) {
                    Set-CtgPhase $job.id "verifying $($job.systemKey)"
                    $vfn = $handler.Validate
                    $vbody = @{ agentId = $AgentId; status = 'succeeded' }
                    if ($vfn) {
                        $validation = & $vfn $job $creds
                        if ($null -ne $validation) { $vbody.validation = $validation }
                    } else {
                        # No validator: report a passing validation, NOT a result — posting a result
                        # here would REPLACE the executor's stored result (and its WARN action lines)
                        # when the auto-verify sweep re-runs a succeeded job.
                        $vbody.validation = @{ ok = $true; checks = @(@{ name = 'no validator for this system — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
                    }
                    $null = Invoke-AppApi POST "/api/jobs/$($job.id)/result" $vbody
                    continue
                }

                $dryRun = [bool]$job.dryRun
                Set-CtgPhase $job.id "$($job.action) $($job.systemKey)$(if ($dryRun) { ' (dry run)' })"
                # Self-heal once: if execution fails because a cmdlet's module isn't installed, find +
                # install it (trusted modules only) and retry — so a missing Graph/EXO submodule fixes
                # itself instead of failing the step.
                $outcome = $null
                for ($try = 0; $try -lt 2; $try++) {
                    try { $outcome = Invoke-JobWithValidation -Job $job -Handler $handler -Fn $fn -Creds $creds -DryRun $dryRun; break }
                    catch {
                        $missing = Get-CtgMissingCommandName $_
                        # A missing '*-Ctg*' function is one of OUR bundled module functions, NOT a
                        # gallery module to install. Two causes, distinguished so the operator isn't
                        # sent chasing RSAT on a host where the module loaded fine (INC0858516):
                        # loaded-but-unexported = the module's .psd1 FunctionsToExport filters out
                        # whatever Export-ModuleMember says; not loaded = missing host dependency.
                        if ($missing -like '*-Ctg*') {
                            $owner = Get-Module Coretelligent.* | Where-Object { $_.ExportedFunctions.Keys -notcontains $missing -and (Get-Content -Raw "$($_.ModuleBase)/$($_.Name).psm1" -ErrorAction SilentlyContinue) -match "function\s+$([regex]::Escape($missing))\b" } | Select-Object -First 1
                            if ($owner) {
                                throw "'$missing' exists in the $($owner.Name) module (loaded on this host) but is NOT exported — its .psd1 FunctionsToExport is missing it (manifest drift). Fix the manifest and update the runner; nothing needs installing on this host."
                            }
                            throw "the Coretelligent module providing '$missing' isn't loaded on this host — it needs a host-specific dependency (the ActiveDirectory/RSAT module for AD, ExchangeOnlineManagement for Exchange, the ADSync module for directory-sync). This step must run on the client-network agent that has it, not the central/cloud runner."
                        }
                        if ($try -eq 0 -and $missing) {
                            Set-CtgPhase $job.id "missing command '$missing' — locating + installing its module"
                            $mod = Repair-CtgMissingModule $missing
                            if ($mod) { Set-CtgPhase $job.id "installed $mod — retrying $($job.systemKey)"; continue }
                        }
                        # Self-heal a STALE app-only Graph token: a RequestDenied on m365/entra is often a
                        # token minted BEFORE consent was granted (the runner connects once per tenant and
                        # reuses it). Force a fresh token — disconnect (clears the MSAL cache), drop the
                        # cached connection, reconnect — and retry ONCE. If it's a genuinely missing
                        # permission this just fails again and the accurate hint below fires.
                        if ($try -eq 0 -and ($job.systemKey -in @('m365', 'entra')) -and $handler.ContainsKey('Connect') -and
                            ([string]$_.Exception.Message -match 'Insufficient privileges|Authorization_RequestDenied|Access(Denied| is denied)')) {
                            Set-CtgPhase $job.id "RequestDenied — refreshing the Graph token (new app-only token) and retrying once"
                            try { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null } catch { }
                            if ($script:ConnectedTenant) { [void]$script:ConnectedTenant.Remove($job.systemKey) }
                            & $handler.Connect $job $creds
                            $script:ConnectedTenant[$job.systemKey] = "$(if ($job.client) { $job.client.primaryDomain } else { '' })|$(Get-CtgCredFingerprint $creds)"
                            # Disconnect-MgGraph tore down the session entra/tap/notify/m365-password-reset
                            # share, and the reconnect above bound it to THIS job's tenant — their cached
                            # keys describe a connection that no longer exists. Forget them.
                            Clear-CtgConnectionSiblings -SystemKey $job.systemKey
                            continue
                        }
                        throw
                    }
                }
                $body = @{ agentId = $AgentId; status = 'succeeded'; result = $outcome.Result }
                if ($null -ne $outcome.Validation) { $body.validation = $outcome.Validation }
                # Surface the module's evidence snapshot (e.g. group memberships captured before an
                # offboard removes them) so it's persisted with the job and shown in the run report.
                if ($outcome.Result -and $outcome.Result.PSObject.Properties['Evidence'] -and $null -ne $outcome.Result.Evidence) {
                    $body.evidence = $outcome.Result.Evidence
                }
                # Retry a TRANSIENT failure of the success post (network blip) before giving up. If it
                # still won't post, do NOT fall through to the catch — that would record a false 'failed'
                # for a job that actually SUCCEEDED. Leave it for the app's stale-lease reclaim +
                # idempotent re-run instead.
                $posted = $false
                for ($rp = 0; $rp -lt 3; $rp++) {
                    try { $null = Invoke-AppApi POST "/api/jobs/$($job.id)/result" $body; $posted = $true; break }
                    catch { if ($rp -lt 2) { Start-Sleep -Seconds 5 } }
                }
                if (-not $posted) {
                    Write-Warning "job $($job.id) SUCCEEDED but the result post failed after 3 tries — leaving it for lease-reclaim + idempotent re-run (not recording a false failure)"
                    Write-CtgLog -Level WARN -Message "job $($job.id) [$($job.systemKey)] succeeded; result post failed 3x — will be reclaimed and re-run"
                }
            }
            catch {
                # Walk the FULL inner-exception chain (deduped) so the real cause surfaces — a generic
                # outer like "Authentication failed, see inner exception" usually wraps the actual
                # logon/LDAP error (e.g. "The user name or password is incorrect", "account locked").
                $chain = [System.Collections.Generic.List[string]]::new()
                $exObj = $_.Exception  # keep the top exception object for provider-specific enrichment below
                $ex = $exObj
                while ($ex) { if ($ex.Message) { [void]$chain.Add($ex.Message) }; $ex = $ex.InnerException }
                $msg = (($chain | Select-Object -Unique) -join ' <- ')
                if (-not $msg) { $msg = $_.Exception.GetType().Name }
                # A Graph "Insufficient privileges" tells you nothing about WHICH permission is missing.
                # Always append the permission the FAILING PHASE needs (reliable across auth modes), and
                # refine it with the precise gap from granted scopes when we can read them. Best-effort —
                # never let this enrichment break the real error report.
                if (($job.systemKey -in @('m365', 'entra')) -and ($msg -match 'Insufficient privileges|Authorization_RequestDenied|Access(Denied| is denied)')) {
                    $ph = [string]$script:Phase
                    $need = if ($ph -match 'group') { 'Group.ReadWrite.All (or GroupMember.ReadWrite.All)' }
                            elseif ($ph -match 'licen') { 'User.ReadWrite.All + Organization.Read.All' }
                            elseif ($ph -match 'user|creat|onboard|attribute|disable') { 'User.ReadWrite.All' }
                            else { 'User.ReadWrite.All, Group.ReadWrite.All, Organization.Read.All' }
                    $hint = "the app registration is missing a Graph APPLICATION permission for this step ($ph) — grant + admin-consent: $need"
                    try {
                        # Prefer the REAL consented application permissions (read from the directory) over the
                        # phase heuristic — app-only auth hides them from Get-MgContext.Scopes.
                        $real = Get-CtgGrantedGraphAppRoles
                        $granted = @()
                        if ($real.ok) { $granted = @($real.roles) }
                        else { $ctx = Get-MgContext; if ($ctx -and $ctx.Scopes) { $granted = @($ctx.Scopes) } }
                        if ($real.ok) {
                            $gaps = Get-CtgGraphScopeGaps $granted
                            $hint = if ($gaps.Count) {
                                "missing Graph permission(s): $($gaps -join ' || '). Consented in this tenant: [$(@($granted) -join ', ')]. Grant + admin-consent the missing ones (APPLICATION permissions) IN THIS TENANT."
                            } else {
                                "the app HAS the expected Graph permissions in this tenant ([$(@($granted) -join ', ')]). 'RequestDenied' here usually means a STALE TOKEN (runner connected before consent — restart the runner), recent consent not yet propagated, or the target object is protected (role-assignable/admin user). It is NOT a missing User.ReadWrite.All."
                            }
                        }
                        elseif ($granted.Count -gt 0) {
                            $gaps = Get-CtgGraphScopeGaps $granted
                            if ($gaps.Count) { $hint = "missing Graph permission(s): $($gaps -join ' || '). Grant + admin-consent (Application permissions on the app registration)." }
                        }
                        else { $hint = "$hint — note: couldn't read the app's consented permissions to confirm ($($real.reason))." }
                    } catch { }
                    $msg += " — $hint"
                }
                # An AD failure ("unwilling to process the request" = LDAP 53, "access is denied", a
                # referral, a constraint violation) names no DC and no reason. Append the ACTIONABLE
                # context so the operator sees the cause without hand-running DC tests: which DC the
                # connection targeted, whether that DC is WRITABLE (a read-only DC / RODC refuses EVERY
                # write — it returns exactly this error), the identity used, and any richer server-side AD
                # error message. Best-effort + read-only; never let the enrichment mask the real failure.
                if (($job.systemKey -in @('active-directory', 'directory-sync')) -and
                    ($msg -match 'unwilling to process|will not perform|[Aa]ccess is denied|referral was returned|constraint violation|not a valid')) {
                    try {
                        $bits = [System.Collections.Generic.List[string]]::new()
                        $adc = New-CtgAdConnection $creds
                        $srv = if ($adc.Server) { [string]$adc.Server } else { $env:COMPUTERNAME }
                        [void]$bits.Add("target DC: $srv")
                        $dc = Get-ADDomainController -Identity $srv -ErrorAction SilentlyContinue
                        if ($dc) {
                            [void]$bits.Add("writable: $(-not [bool]$dc.IsReadOnly)")
                            if ($dc.IsReadOnly) { [void]$bits.Add("*** READ-ONLY DC (RODC) — it refuses ALL writes; point the ad-dc secret's Server/DomainController at a WRITABLE DC ***") }
                        }
                        [void]$bits.Add("as: $(if ($adc.Credential) { $adc.Credential.UserName } else { "$env:USERDOMAIN\$env:USERNAME (agent SYSTEM identity)" })")
                        # ADException carries a richer server reason than .Message (survives remoting as a note property).
                        $adEx = $exObj
                        while ($adEx) {
                            foreach ($p in 'ServerErrorMessage', 'ExtendedErrorMessage') {
                                $pv = $adEx.PSObject.Properties[$p]
                                if ($pv -and $pv.Value) { [void]$bits.Add("${p}: $($pv.Value)") }
                            }
                            $adEx = $adEx.InnerException
                        }
                        if ($msg -match 'unwilling to process|will not perform') {
                            [void]$bits.Add("LDAP 53 usually = read-only/RODC target, RID pool exhausted, or the account can't create the object in the target OU — verify the target DC is writable and the ad-dc account can create in that OU")
                        }
                        $msg += " — [$($bits -join ' | ')]"
                    } catch { }
                }
                # Name the phase that failed ("while connecting to on-prem Exchange (…): Unauthorized")
                # so the operator sees WHAT broke, not just the bare provider message.
                $where = if ($script:Phase) { " while $($script:Phase)" } else { "" }
                # Scrub any brokered secret value the exception may have echoed before it's persisted.
                $err = Protect-CtgSecretsInText "[$($job.systemKey)]$($where): $msg" $creds -ExtraValues @([string](Get-CtgProp $job.config 'newPassword'), [string](Get-CtgProp $job.config 'initialPassword'))
                Write-Warning "job $($job.id) failed: $err"
                Write-CtgLog -Level ERROR -Message "job $($job.id) [$($job.systemKey)] $($job.action) FAILED: $err"
                $null = Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = $err }
            }
            finally { $global:CtgProgressJobId = $null }  # don't let a stray post target a finished job
        }

        # Separate, isolated lane: operator-requested connection/permission tests (cloud here on the
        # central runner; on-prem on the client agent). Never affects the job pipeline above.
        Invoke-CtgConnectionTests
        Invoke-CtgCloudGroupDiscovery
    }
    catch {
        Write-Warning "poll cycle error: $($_.Exception.Message)"
        Write-CtgLog -Level WARN -Message "poll cycle error: $($_.Exception.Message)"
    }
    # Drain: if this cycle claimed work, more may have just unblocked (dependency chains, an
    # operator's re-run) — poll again immediately and only sleep once the queue is empty.
    if (@($jobs).Count -eq 0) { Start-Sleep -Seconds $PollSeconds }
}
