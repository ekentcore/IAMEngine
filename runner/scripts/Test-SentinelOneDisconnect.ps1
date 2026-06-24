#Requires -Version 7.0
<#
.SYNOPSIS
    Manual diagnostic for the SentinelOne endpoint-containment flow: look up an agent by computer name
    and network-isolate ("disconnect") it, or pull a user's Entra-registered devices and choose per
    device whether to isolate it in SentinelOne. Reuses the production Coretelligent.SentinelOne module
    (no duplicated API logic).

.DESCRIPTION
    SentinelOne flow (matches the module):
      GET  /web/api/v2.1/agents?computerName=<name>   -> { data:[ { id, computerName, networkStatus } ] }
      POST /web/api/v2.1/agents/actions/disconnect     { filter:{ ids:[id] } }   (network quarantine)
    "Disabled"/isolated == networkStatus 'disconnected' (reversible via the console's reconnect/connect).

.PARAMETER ComputerName
    S1-only mode: find this machine's agent and offer to network-isolate it.

.PARAMETER Email
    Entra mode: pull this user's registered devices, then per device offer to isolate it in S1.

.EXAMPLE
    pwsh Test-SentinelOneDisconnect.ps1 -ComputerName LT-JDOE -WhatIf
.EXAMPLE
    S1_BASE_URL=https://usea1-partners.sentinelone.net S1_TOKEN=... \
      pwsh Test-SentinelOneDisconnect.ps1 -ComputerName LT-JDOE
.EXAMPLE
    pwsh Test-SentinelOneDisconnect.ps1 -Email jdoe@coretelligent.com -DisableInEntra

.NOTES
    -Email mode needs the Microsoft.Graph modules (Microsoft.Graph.Authentication +
    Microsoft.Graph.Identity.DirectoryManagement) — the same ones the runner uses. -ComputerName mode is
    pure REST and needs nothing extra. Credentials come from params or env; never logged.
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Computer')]
param(
    [Parameter(ParameterSetName = 'Computer', Mandatory)][string]$ComputerName,
    [Parameter(ParameterSetName = 'Email', Mandatory)][string]$Email,

    # SentinelOne ('sentinelone' Delinea secret): management console URL + a service-user API token.
    [string]$S1BaseUrl = $env:S1_BASE_URL,
    [string]$S1Token   = $env:S1_TOKEN,

    # Entra app registration ('m365-admin' secret) — only needed for -Email mode.
    [string]$TenantId     = $env:M365_TENANT_ID,
    [string]$ClientId     = $env:M365_CLIENT_ID,
    [string]$ClientSecret = $env:M365_CLIENT_SECRET,

    # --- Resolve creds straight from Delinea instead of pasting them ---------------------------------
    # Pass a client's Delinea secret id(s) and the script pulls the fields at runtime (using YOUR
    # Delinea login — same OAuth2 path the runner uses). e.g. Coretelligent m365-admin = 56410.
    # ('sentinelone' isn't mapped for Coretelligent yet, so -S1Token stays manual there.)
    [string]$M365SecretId,
    [string]$S1SecretId,
    [string]$DelineaBaseUrl  = $env:DELINEA_BASE_URL,
    [string]$DelineaUser     = $env:DELINEA_USER,
    [string]$DelineaPassword = $env:DELINEA_PASSWORD,

    # -Email mode: just LIST the user's Entra devices and stop (no SentinelOne). Handy when you have
    # Graph creds but not the S1 API token yet.
    [switch]$ListOnly,
    # -Email mode: also disable each device in Entra (Update-MgDevice AccountEnabled=$false). Off by
    # default so the script is safe to run as a read+isolate test without touching Entra.
    [switch]$DisableInEntra,
    # Skip the per-device y/N prompt and act on every match.
    [switch]$AutoConfirm
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/../modules/Coretelligent.SentinelOne/Coretelligent.SentinelOne.psm1" -Force

# Lazy Delinea session — only connect if a -*SecretId was given.
$script:DelineaReady = $false
function Resolve-DelineaSecret {
    param([Parameter(Mandatory)][string]$Id)
    if (-not $script:DelineaReady) {
        if (-not $DelineaBaseUrl)  { throw "Delinea resolution needs DELINEA_BASE_URL (or -DelineaBaseUrl)." }
        if (-not $DelineaUser -or -not $DelineaPassword) { throw "Delinea resolution needs DELINEA_USER + DELINEA_PASSWORD (or -DelineaUser/-DelineaPassword)." }
        Import-Module "$PSScriptRoot/../lib/Coretelligent.Secrets/Coretelligent.Secrets.psm1" -Force
        $dc = [pscredential]::new($DelineaUser, (ConvertTo-SecureString $DelineaPassword -AsPlainText -Force))
        Connect-CtgSecretStore -Credential $dc -BaseUrl $DelineaBaseUrl
        $script:DelineaReady = $true
    }
    Get-CtgSecret -Reference @{ provider = 'delinea'; id = $Id }
}
function Get-Field {
    # First non-empty among the candidate field names (tolerant of Delinea field naming).
    param($Secret, [string[]]$Names)
    foreach ($n in $Names) { $v = $Secret.Fields[$n]; if ($v) { return [string]$v } }
    return $null
}

function Confirm-Action {
    # y/N gate for the interactive flow. Auto-yes under -AutoConfirm or -WhatIf (so -WhatIf previews the
    # action via ShouldProcess instead of stopping at the prompt).
    param([string]$Message)
    if ($AutoConfirm -or $WhatIfPreference) { return $true }
    return ((Read-Host "$Message [y/N]") -match '^(y|yes)$')
}

function Invoke-OneDisconnect {
    # Look up one machine in S1 and offer to network-isolate it (idempotent: skips if already isolated,
    # refuses on an ambiguous >1 match — mirroring the module's offboard behavior).
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Name)

    Write-Host "SentinelOne: looking up '$Name'…" -ForegroundColor Cyan
    $agents = @(Find-CtgS1Agents -ComputerName $Name)
    if ($agents.Count -eq 0) {
        Write-Host "  no SentinelOne agent found for '$Name' (already removed, or a different console)." -ForegroundColor Yellow
        return
    }
    if ($agents.Count -gt 1) {
        $ids = ($agents | ForEach-Object { $_.id }) -join ', '
        Write-Host "  $($agents.Count) agents match '$Name' (ids: $ids) — ambiguous, skipping. Isolate the right one by hand." -ForegroundColor Yellow
        return
    }

    $agent = $agents[0]
    $id = [string]$agent.id
    Write-Host "  matched agent $id — networkStatus: $([string]$agent.networkStatus)"
    if (Test-CtgS1Isolated $agent) {
        Write-Host "  already network-isolated — no change." -ForegroundColor Green
        return
    }
    if (-not (Confirm-Action "  Disconnect (network-isolate) '$Name' [agent $id]?")) {
        Write-Host "  skipped '$Name'." -ForegroundColor DarkGray
        return
    }
    if ($PSCmdlet.ShouldProcess($Name, "Network-isolate SentinelOne agent $id")) {
        Invoke-CtgSentinelOneApi -Method POST -Path '/web/api/v2.1/agents/actions/disconnect' -Body @{ filter = @{ ids = @($id) } } | Out-Null
        Write-Host "  ✓ disconnect (network-isolate) issued for '$Name' (agent $id)." -ForegroundColor Green
    }
}

function Disable-EntraDevice {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Name)
    if ($PSCmdlet.ShouldProcess($Name, "Disable Entra device")) {
        Update-MgDevice -DeviceId $Id -AccountEnabled:$false
        Write-Host "  ✓ disabled Entra device '$Name'." -ForegroundColor Green
    }
}

# --- resolve creds from Delinea when a secret id was given -------------------
if ($S1SecretId) {
    Write-Host "resolving SentinelOne secret $S1SecretId from Delinea…" -ForegroundColor DarkGray
    $s1sec = Resolve-DelineaSecret -Id $S1SecretId
    if (-not $S1BaseUrl) { $S1BaseUrl = Get-Field $s1sec @('BaseUrl', 'Url', 'URL', 'ConsoleUrl', 'ManagementUrl') }
    if (-not $S1Token)   { $S1Token   = Get-Field $s1sec @('ApiToken', 'Token', 'ApiKey', 'API Key', 'Key', 'Password') }
}
if ($M365SecretId) {
    Write-Host "resolving Entra app secret $M365SecretId from Delinea…" -ForegroundColor DarkGray
    $m365sec = Resolve-DelineaSecret -Id $M365SecretId
    if (-not $ClientId)     { $ClientId     = Get-Field $m365sec @('ClientID', 'ClientId', 'Client ID', 'AppId', 'Application (client) ID'); if (-not $ClientId -and $m365sec.Username) { $ClientId = [string]$m365sec.Username } }
    if (-not $ClientSecret) { $ClientSecret = Get-Field $m365sec @('ClientSecret', 'Client Secret', 'Secret', 'Password') }
    if (-not $TenantId)     { $TenantId     = Get-Field $m365sec @('TenantId', 'Tenant', 'Directory (tenant) ID', 'Domain') }
}

# Is SentinelOne in play this run? Always for -ComputerName; for -Email unless -ListOnly or no token.
$wantS1 = ($PSCmdlet.ParameterSetName -eq 'Computer') -or (-not $ListOnly)
if ($wantS1 -and -not $S1Token) {
    if ($PSCmdlet.ParameterSetName -eq 'Computer') { throw "missing SentinelOne token — pass -S1Token / set S1_TOKEN (a management API token), or -S1SecretId once 'sentinelone' is mapped in Delinea." }
    Write-Host "note: no SentinelOne token — listing Entra devices only (set S1_TOKEN/-S1Token to also disconnect)." -ForegroundColor Yellow
    $wantS1 = $false
}
if ($wantS1) {
    if (-not $S1BaseUrl) { throw "missing SentinelOne console URL — pass -S1BaseUrl / set S1_BASE_URL (e.g. https://usea1-partners.sentinelone.net), or -S1SecretId." }
    Connect-CtgSentinelOne -BaseUrl $S1BaseUrl -Token $S1Token
}

if ($PSCmdlet.ParameterSetName -eq 'Computer') {
    Invoke-OneDisconnect -Name $ComputerName
    return
}

# --- Email mode: pull Entra devices, then (optionally) per-device isolate -----
if (-not $TenantId)     { throw "missing tenant — pass -TenantId / set M365_TENANT_ID, or -M365SecretId." }
if (-not $ClientId)     { throw "missing app id — pass -ClientId / set M365_CLIENT_ID, or -M365SecretId." }
if (-not $ClientSecret) { throw "missing app secret — pass -ClientSecret / set M365_CLIENT_SECRET, or -M365SecretId." }

# Graph app-only (client-secret) — identical to Connect-CtgM365; inlined so the diagnostic doesn't pull
# the full M365 module's dependency chain. Needs Microsoft.Graph.Authentication + .Identity.DirectoryManagement.
$cred = [pscredential]::new($ClientId, (ConvertTo-SecureString $ClientSecret -AsPlainText -Force))
Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $cred -NoWelcome

Write-Host "pulling Entra registered devices for $Email…" -ForegroundColor Cyan
$devices = @(
    @(Get-MgUserRegisteredDevice -UserId $Email -All) |
        Where-Object { $_.AdditionalProperties['@odata.type'] -eq '#microsoft.graph.device' } |
        ForEach-Object { [pscustomobject]@{ Id = $_.Id; DisplayName = [string]$_.AdditionalProperties['displayName'] } }
)
if ($devices.Count -eq 0) {
    Write-Host "no Entra registered devices for $Email." -ForegroundColor Yellow
    return
}
Write-Host "found $($devices.Count) device(s): $(($devices | ForEach-Object { $_.DisplayName }) -join ', ')`n"

foreach ($d in $devices) {
    Write-Host "── device: $($d.DisplayName)   (Entra id $($d.Id)) ──" -ForegroundColor Cyan
    if ($DisableInEntra) { Disable-EntraDevice -Id $d.Id -Name $d.DisplayName }
    if ($wantS1) { Invoke-OneDisconnect -Name $d.DisplayName }
    else         { Write-Host "  (SentinelOne skipped — list-only)" -ForegroundColor DarkGray }
    Write-Host ""
}
