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
# Future modules (Coretelligent.ActiveDirectory, .Mimecast, …) register here.

# systemKey -> { Onboard = <fn>, Offboard = <fn> }. Add a line per module as built.
$DISPATCH = @{
    'm365' = @{
        Onboard  = { param($job,$cred) Invoke-CtgM365Onboarding -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        # Offboard = { param($job,$cred) Invoke-CtgM365Offboarding ... }
    }
    # 'active-directory' = @{ Onboard = {...}; Offboard = {...} }
}

function Invoke-AppApi {
    param([string]$Method, [string]$Path, $Body)
    $p = @{ Method = $Method; Uri = "$AppUrl$Path"; ContentType = 'application/json' }
    if ($ApiToken) { $p.Headers = @{ Authorization = "Bearer $ApiToken" } }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 12) }
    Invoke-RestMethod @p   # mTLS replaces the shared bearer in production
}

function Get-JobCredential {
    param($JobId, $SecretName)
    (Invoke-AppApi POST "/api/jobs/$JobId/credential" @{ agentId = $AgentId; secretName = $SecretName })
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
                $cred = if ($job.secretNames) { $creds[$job.secretNames[0]] } else { $null }

                $result = & $fn $job $cred $creds
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
