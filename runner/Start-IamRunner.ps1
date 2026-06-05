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
# (Coretelligent.Secrets is no longer imported: the app now resolves the secret value and pushes it
# down in the credential response — the runner no longer talks to Delinea itself.)
# These modules depend on host-specific cmdlets: the AD module needs the on-prem ActiveDirectory
# module (client-network agent only); Exchange needs ExchangeOnlineManagement. Load each only
# where its dependency is present so the central cloud runner doesn't fail to import.
if (Get-Module -ListAvailable ActiveDirectory) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
}
if (Get-Module -ListAvailable ExchangeOnlineManagement) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
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
        $server = $s.Fields['Server']
        if (-not $server) { $server = $s.Fields['DomainController'] }
        if ($server) { $ad.Server = $server }
    }
    return $ad
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
        Onboard  = { param($job, $creds) Invoke-CtgADOnboarding  -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Offboard = { param($job, $creds) Invoke-CtgADOffboarding -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Validate = { param($job, $creds) Confirm-CtgAD -User (Add-ClientContext $job) -Config $job.config -Action $job.action -AdConnection (New-CtgAdConnection $creds) }
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

function Update-CtgRunner {
    # Operator clicked "Update": re-pull every runner file from the app's manifest into our own
    # folder, then relaunch this script (new pwsh process = new code) and exit. Re-runnable and
    # self-contained so the operator never has to hand-walk a re-pull on the host again.
    $H = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }
    Write-Host "self-update: pulling latest runner from $AppUrl" -ForegroundColor Yellow
    $manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H
    foreach ($rel in $manifest.files) {
        # Manifest paths are POSIX-style ('a/b/c'); Join-Path accepts '/' on Windows and it's native
        # on macOS/Linux, so use $rel as-is rather than forcing a backslash (which would corrupt
        # paths on a non-Windows central runner).
        $dest = Join-Path $PSScriptRoot $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        $resp = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H
        [System.IO.File]::WriteAllText($dest, $resp.Content)
    }
    Write-Host "self-update: pulled $($manifest.files.Count) files — restarting" -ForegroundColor Green
    # Relaunch a fresh process running the just-downloaded script, then exit this one. Detached
    # (Start-Process) so it survives this process exiting; a SYSTEM Scheduled Task launches it the
    # same way on next boot, so this stays consistent across foreground + task hosting.
    $pwshPath = (Get-Process -Id $PID).Path
    $self = Join-Path $PSScriptRoot 'Start-IamRunner.ps1'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-AppUrl', $AppUrl, '-AgentId', $AgentId, '-PollSeconds', $PollSeconds, '-BatchSize', $BatchSize)
    # Forward the bearer if it was passed as an explicit arg (env is inherited automatically, but an
    # explicit -ApiToken would otherwise be lost and the restarted runner would 401 on every call).
    if ($ApiToken) { $argList += @('-ApiToken', $ApiToken) }
    Start-Process -FilePath $pwshPath -ArgumentList $argList
    exit 0
}

function Protect-CtgSecretsInText {
    # Redact brokered secret VALUES out of free text (a failure message) before it's posted to the
    # app — Job.error is persisted and shown in the run report + ServiceNow work note + audit, and a
    # failing API call can echo a key/token/password in its exception. Only values of secret-named
    # fields are scrubbed, so usernames/servers stay visible for diagnosis.
    param([string]$Text, [hashtable]$Creds)
    if ([string]::IsNullOrEmpty($Text) -or -not $Creds) { return $Text }
    foreach ($c in $Creds.Values) {
        if (-not $c -or -not $c.Fields) { continue }
        foreach ($k in @($c.Fields.Keys)) {
            if ($k -notmatch '(?i)pass|secret|key|token|credential') { continue }
            $v = [string]$c.Fields[$k]
            if ($v.Length -ge 4 -and $Text.Contains($v)) { $Text = $Text.Replace($v, '***') }
        }
    }
    return $Text
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
    $username = $fields['Username']
    $password = if ($fields.ContainsKey('Password') -and $fields['Password']) {
        ConvertTo-SecureString ([string]$fields['Password']) -AsPlainText -Force
    } else { $null }
    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
    [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $fields }
}

Write-Host "iam-engine runner $AgentId polling $AppUrl every ${PollSeconds}s" -ForegroundColor Cyan
while ($true) {
    try {
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; version = '0.1.0' }
        if ($hb.enabled -eq $false) { Write-Warning "agent disabled server-side; stopping."; break }
        if ($hb.update -eq $true) { Update-CtgRunner }  # operator requested self-update — re-pull + restart (never returns)
        $jobs = Invoke-AppApi POST '/api/jobs/claim' @{ agentId = $AgentId; batchSize = $BatchSize }

        foreach ($job in @($jobs)) {
            $creds = @{}  # in scope for the catch's secret-scrub even if broking/execution throws early
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
                # Tag the system and unwrap the inner exception so the run report shows the real
                # cause, not just the outermost message.
                $msg = $_.Exception.Message
                if ($_.Exception.InnerException) { $msg += " <- $($_.Exception.InnerException.Message)" }
                # Scrub any brokered secret value the exception may have echoed before it's persisted.
                $err = Protect-CtgSecretsInText "[$($job.systemKey)] $msg" $creds
                Write-Warning "job $($job.id) failed: $err"
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = $err }
            }
        }
    }
    catch {
        Write-Warning "poll cycle error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $PollSeconds
}
