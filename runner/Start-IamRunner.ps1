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
Import-Module "$PSScriptRoot/modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Zoom/Coretelligent.Zoom.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Adobe/Coretelligent.Adobe.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Perimeter81/Coretelligent.Perimeter81.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psd1" -Force
Import-Module "$PSScriptRoot/lib/Coretelligent.Secrets/Coretelligent.Secrets.psm1" -Force
# These modules depend on host-specific cmdlets: the AD module needs the on-prem ActiveDirectory
# module (client-network agent only); Exchange needs ExchangeOnlineManagement. Load each only
# where its dependency is present so the central cloud runner doesn't fail to import.
if (Get-Module -ListAvailable ActiveDirectory) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
}
if (Get-Module -ListAvailable ExchangeOnlineManagement) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
}

# systemKey -> { Connect?; Onboard; Offboard }. Connect (optional) runs once per tenant before
# the first job for that system; the action lanes receive ($job, $creds) where $creds maps each
# named secret to its resolved credential object (.Credential is a pscredential).
$DISPATCH = @{
    'm365' = @{
        Connect  = { param($job, $creds) Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $job.client.primaryDomain }
        Onboard  = { param($job, $creds) Invoke-CtgM365Onboarding  -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        Offboard = { param($job, $creds) Invoke-CtgM365Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgM365 -User $job.payload -Config $job.config -Action $job.action }
    }
    'active-directory' = @{
        Onboard  = { param($job, $creds) Invoke-CtgADOnboarding  -User (Add-ClientContext $job) -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgADOffboarding -User (Add-ClientContext $job) -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgAD -User (Add-ClientContext $job) -Config $job.config -Action $job.action }
    }
    'mimecast' = @{
        Connect  = { param($job, $creds) Connect-CtgMimecast -Credential $creds['mimecast'].Credential }
        Onboard  = { param($job, $creds) Invoke-CtgMimecastOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgMimecastOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgMimecast -User $job.payload -Config $job.config -Action $job.action }
    }
    'directory-sync' = @{
        Onboard  = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgDirectorySync -User $job.payload -Config $job.config -Action $job.action }
    }
    'exchange' = @{
        # EXO app-only needs certificate auth (m365-admin carries the cert thumbprint). A hybrid
        # onboard ALSO needs an on-prem Exchange session for Enable-RemoteMailbox — established only
        # when the job brokered the `exchange-onprem` secret (its Fields carry the PowerShell URI).
        Connect  = { param($job, $creds)
            $s = $creds['m365-admin']; Connect-CtgExchange -AppId $s.Credential.UserName -Organization $job.client.primaryDomain -CertificateThumbprint $s.Fields['CertificateThumbprint']
            # On-prem session only for onboard (Enable-RemoteMailbox) — offboard is EXO-only.
            $op = $creds['exchange-onprem']
            if ($op -and $job.action -ne 'offboard') { Connect-CtgExchangeOnPrem -ConnectionUri $op.Fields['ConnectionUri'] -Credential $op.Credential }
        }
        # Hybrid onboard across the AAD Connect sync boundary: enable remote mailbox -> wait for sync -> regional/calendar (one job).
        Onboard  = { param($job, $creds) Invoke-CtgExchangeHybridOnboard -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgExchangeOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgExchange -User $job.payload -Config $job.config -Action $job.action }
    }
    'zoom' = @{
        Connect  = { param($job, $creds) Connect-CtgZoom -Credential $creds['zoom'].Credential -AccountId $creds['zoom'].Fields['AccountId'] }
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
    'google-workspace' = @{
        Connect  = { param($job, $creds) Connect-CtgGoogle -Credential $creds['google-admin'].Credential -CustomerId $creds['google-admin'].Fields['CustomerId'] }
        Onboard  = { param($job, $creds) Invoke-CtgGoogleOnboarding  -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        Offboard = { param($job, $creds) Invoke-CtgGoogleOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgGoogle -User $job.payload -Config $job.config -Action $job.action }
    }
}

# entra is the Entra-ID slice of the M365 module — same executor + read-backs (catalog
# moduleName = Coretelligent.M365). Alias it so an `entra` job isn't left without an executor.
$DISPATCH['entra'] = $DISPATCH['m365']

# Action -> validate, with idempotent auto-retry. On a validation miss we re-run the (idempotent)
# action and re-validate up to $MaxRevalidate times — this self-heals eventual-consistency lags.
# A persistent miss is NOT a failure: the job still succeeds; the validation block (ok=$false)
# rides along on the result and the app's run report flags it as a warning.
$MaxRevalidate = 2

function Invoke-JobWithValidation {
    param($Job, $Handler, [scriptblock]$Fn, $Creds, [bool]$DryRun)

    # Dry run: set WhatIf so every module's SupportsShouldProcess short-circuits the mutations,
    # then run the validators read-only — the executable confirmation of the app-side playbook.
    if ($DryRun) { $WhatIfPreference = $true }
    try { $result = & $Fn $Job $Creds }
    finally { if ($DryRun) { $WhatIfPreference = $false } }

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
    # ngrok-skip-browser-warning bypasses ngrok-free's HTML interstitial (harmless on other hosts).
    $headers = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $headers['Authorization'] = "Bearer $ApiToken" }
    $p = @{ Method = $Method; Uri = "$AppUrl$Path"; ContentType = 'application/json'; Headers = $headers }
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
                    # No executor for this system: resolve as a manual follow-up, not a failure,
                    # so an uncovered `api` system doesn't kill the whole case.
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no executor for $($job.systemKey) — manual follow-up" }
                    continue
                }
                $fn = if ($job.action -eq 'offboard') { $handler.Offboard } else { $handler.Onboard }
                if (-not $fn) {
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no $($job.action) lane for $($job.systemKey) — manual follow-up" }
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

                $dryRun = [bool]$job.dryRun
                $outcome = Invoke-JobWithValidation -Job $job -Handler $handler -Fn $fn -Creds $creds -DryRun $dryRun
                $body = @{ agentId = $AgentId; status = 'succeeded'; result = $outcome.Result }
                if ($null -ne $outcome.Validation) { $body.validation = $outcome.Validation }
                # Surface the module's evidence snapshot (e.g. group memberships captured before an
                # offboard removes them) so it's persisted with the job and shown in the run report.
                if ($outcome.Result -and $outcome.Result.PSObject.Properties['Evidence'] -and $null -ne $outcome.Result.Evidence) {
                    $body.evidence = $outcome.Result.Evidence
                }
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" $body
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
