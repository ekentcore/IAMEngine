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
    [int]$PollSeconds = 15,
    [int]$BatchSize   = 5
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force
Import-Module "$PSScriptRoot/lib/Coretelligent.Secrets/Coretelligent.Secrets.psm1" -Force
# The AD module needs the on-prem ActiveDirectory cmdlets — only present on a client-network
# agent host. Load it only there so the central cloud runner doesn't fail to import.
if (Get-Module -ListAvailable ActiveDirectory) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
}
# Future modules (Coretelligent.Mimecast, …) register here.

# systemKey -> { Connect?; Onboard; Offboard }. Connect (optional) runs once per tenant before
# the first job for that system; the action lanes receive ($job, $creds) where $creds maps each
# named secret to its resolved credential object (.Credential is a pscredential).
$DISPATCH = @{
    'm365' = @{
        Connect  = { param($job, $creds) Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $job.client.primaryDomain }
        Onboard  = { param($job, $creds) Invoke-CtgM365Onboarding  -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        Offboard = { param($job, $creds) Invoke-CtgM365Offboarding -User $job.payload -Config $job.config }
    }
    'active-directory' = @{
        Onboard  = { param($job, $creds) Invoke-CtgADOnboarding  -User (Add-ClientContext $job) -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgADOffboarding -User (Add-ClientContext $job) -Config $job.config }
    }
}

# Track which (system|tenant) Connect blocks have already run this process.
$script:Connected = [System.Collections.Generic.HashSet[string]]::new()

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

function Invoke-AppApi {
    param([string]$Method, [string]$Path, $Body)
    $p = @{ Method = $Method; Uri = "$AppUrl$Path"; ContentType = 'application/json' }
    if ($ApiToken) { $p.Headers = @{ Authorization = "Bearer $ApiToken" } }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 12) }
    Invoke-RestMethod @p   # mTLS replaces the shared bearer in production
}

function Get-JobCredential {
    # Ask the app to broker secret $SecretName for this job, then exchange the returned vault
    # reference for the real credential via Delinea (Coretelligent.Secrets). The app never holds
    # secret values — only references — so the resolution happens here on the runner.
    param($JobId, $SecretName)
    $ref = Invoke-AppApi POST "/api/jobs/$JobId/credential" @{ agentId = $AgentId; secretName = $SecretName }
    if (-not $ref.externalId) { throw "credential broker returned no externalId for '$SecretName'" }
    Get-CtgSecret -Reference @{ provider = $ref.provider; id = $ref.externalId }
}

# Bootstrap the Delinea session once (machine identity from env) so Get-CtgSecret can resolve.
if ($env:DELINEA_USER -and $env:DELINEA_PASSWORD) {
    $bootstrap = [pscredential]::new($env:DELINEA_USER, (ConvertTo-SecureString $env:DELINEA_PASSWORD -AsPlainText -Force))
    Connect-CtgSecretStore -Credential $bootstrap
}

Write-Host "iam-engine runner $AgentId polling $AppUrl every ${PollSeconds}s" -ForegroundColor Cyan
while ($true) {
    try {
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; version = '0.1.0' }
        if ($hb.enabled -eq $false) { Write-Warning "agent disabled server-side; stopping."; break }
        $jobs = Invoke-AppApi POST '/api/jobs/claim' @{ agentId = $AgentId; batchSize = $BatchSize }

        foreach ($job in @($jobs)) {
            try {
                $handler = $DISPATCH[$job.systemKey]
                if (-not $handler) {
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = "no executor for $($job.systemKey)" }
                    continue
                }
                $fn = if ($job.action -eq 'offboard') { $handler.Offboard } else { $handler.Onboard }
                if (-not $fn) {
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = "no $($job.action) lane for $($job.systemKey)" }
                    continue
                }

                # Broker every secret the job names (least-privilege, one call each), keyed by name.
                $creds = @{}
                foreach ($sn in @($job.secretNames)) { if ($sn) { $creds[$sn] = Get-JobCredential $job.id $sn } }

                # Connect once per (system|tenant) before the first job that needs it.
                if ($handler.ContainsKey('Connect')) {
                    $tenant = if ($job.client) { $job.client.primaryDomain } else { '' }
                    $key = "$($job.systemKey)|$tenant"
                    if ($script:Connected.Add($key)) { & $handler.Connect $job $creds }
                }

                $result = & $fn $job $creds
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'succeeded'; result = $result }
            }
            catch {
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = $_.Exception.Message }
            }
        }
    }
    catch {
        Write-Warning "poll cycle error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $PollSeconds
}
