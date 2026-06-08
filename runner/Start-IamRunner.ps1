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
    [int]$BatchSize   = 5,
    # ExchangeOnlineManagement 3.10.0's REST cmdlets break on PowerShell 7.6 ("[HttpResponseMessage]
    # does not contain a method named 'GetResponseHeader'"); 3.9.2 is the known-good build. Pin the
    # version the runner loads so it never auto-picks a broken one. Override per host if needed.
    [string]$ExoModuleVersion = '3.9.2'
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
            $s = $creds['m365-admin']
            Set-CtgPhase $job.id "connecting to Exchange Online (app-only cert auth, app $($s.Credential.UserName))"
            Connect-CtgExchange -AppId $s.Credential.UserName -Organization $job.client.primaryDomain -CertificateThumbprint $s.Fields['CertificateThumbprint']
            # On-prem session only for onboard (Enable-RemoteMailbox) — offboard is EXO-only. The
            # credential comes from the brokered `exchange-onprem` secret (which may point at the same
            # Delinea id as ad-dc — the domain admin already has Exchange rights). The PowerShell URI
            # comes from that secret's ConnectionUri field if present, else from the system config
            # (`onPremExchangeUri`) so reusing the ad-dc secret needs no extra Delinea field.
            $op = $creds['exchange-onprem']
            if ($op -and $job.action -ne 'offboard') {
                $opUri = if ($op.Fields['ConnectionUri']) { $op.Fields['ConnectionUri'] } else { $job.config.onPremExchangeUri }
                if (-not $opUri) { throw "on-prem session needs a ConnectionUri (set the exchange system's onPremExchangeUri, e.g. http://core-cce1-ex01.<domain>/PowerShell/)" }
                Set-CtgPhase $job.id "connecting to on-prem Exchange ($opUri)"
                Connect-CtgExchangeOnPrem -ConnectionUri $opUri -Credential $op.Credential
            }
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

function Set-CtgPhase {
    # Record what we're doing right now: keep it in $script:Phase (so a thrown error can say WHICH
    # phase failed instead of a bare "Unauthorized"), and beacon it to the app so the run report can
    # show live progress. The beacon is best-effort — a failed post must never break the job.
    param([string]$JobId, [string]$Phase)
    $script:Phase = $Phase
    Write-Host "  · $Phase" -ForegroundColor DarkGray
    if ($JobId) { try { Invoke-AppApi POST "/api/jobs/$JobId/progress" @{ agentId = $AgentId; phase = $Phase } | Out-Null } catch { } }
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
    Write-Host "self-update: pulled $($manifest.files.Count) files (build $($manifest.buildId)) — restarting" -ForegroundColor Green
    # Relaunch a fresh process on the just-downloaded script, then exit this one. Spawn it via WMI
    # (Win32_Process.Create), NOT Start-Process: the WMI host creates the process, so it BREAKS AWAY
    # from this process's job object and survives our exit. Under a SYSTEM Scheduled Task a
    # Start-Process child lives in the task's job object and is KILLED when this process exits — which
    # silently left the runner on the OLD code (the pull succeeded but the restart never landed).
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
    $self = Join-Path $PSScriptRoot 'Start-IamRunner.ps1'
    $qq = { param([string]$s) '"' + ($s -replace '"', '\"') + '"' }  # quote args (paths may have spaces)
    $cmd = (& $qq $pwshPath) + ' -NoProfile -ExecutionPolicy Bypass -File ' + (& $qq $self) +
           ' -AppUrl ' + (& $qq $AppUrl) + ' -AgentId ' + (& $qq $AgentId) +
           ' -PollSeconds ' + $PollSeconds + ' -BatchSize ' + $BatchSize +
           ' -ExoModuleVersion ' + (& $qq $ExoModuleVersion)
    # Forward an explicit -ApiToken (env is inherited; an explicit arg would otherwise be lost -> 401).
    if ($ApiToken) { $cmd += ' -ApiToken ' + (& $qq $ApiToken) }
    # WMI Win32_Process.Create is Windows-only and is needed specifically to break out of a SYSTEM
    # Scheduled Task's job object. On macOS/Linux (the central cloud runner) there's no CIM server —
    # calling it errors or stalls, which left the Mac stuck "updating" (pull ok, restart never landed).
    # So branch on platform: WMI on Windows, a plain detached relaunch everywhere else.
    if ($IsWindows) {
        try {
            $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
            if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
            Write-Host "self-update: relaunched on new code (pid $($r.ProcessId))" -ForegroundColor Green
        }
        catch {
            Write-Warning "self-update relaunch via WMI failed ($($_.Exception.Message)); using Start-Process"
            Start-Process -FilePath $pwshPath -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion) | Out-Null
        }
    }
    else {
        # macOS/Linux: no job object to escape, so a detached child survives our exit. Pass args
        # explicitly (env is inherited, but an explicit -ApiToken arg would otherwise be lost).
        $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion)
        if ($ApiToken) { $a += @('-ApiToken',$ApiToken) }
        Start-Process -FilePath $pwshPath -ArgumentList $a | Out-Null
        Write-Host "self-update: relaunched on new code (Start-Process)" -ForegroundColor Green
    }
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

function Get-CtgBuildId {
    # This runner's build id = SHA-256 over its own files (raw bytes, ordinal-sorted POSIX relpaths),
    # truncated to 12 hex. EXACTLY the hash the app computes over the bundle it serves (lib/runner/
    # bundle.ts runnerBuildId), so the app can show "up to date" vs "update available" with no version
    # string to bump and no marker file to keep in sync. 'unknown' if anything goes wrong.
    $root = $PSScriptRoot
    $skip = 'tests', 'dist', '.git', 'node_modules'
    try {
        $rels = foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File) {
            $rel = ([System.IO.Path]::GetRelativePath($root, $f.FullName)) -replace '\\', '/'
            if ($rel.Split('/') | Where-Object { $skip -contains $_ }) { continue }
            if ($f.Name -like '*.Tests.ps1' -or $f.Name -eq '.DS_Store' -or $f.Name -eq '.build') { continue }
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
        $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($ms)
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

# Build id of the code we're actually running = hash of our own files (matches the app's hash of the
# bundle it serves). Reported on every heartbeat → accurate even if a past restart half-landed, with
# no marker file to keep in sync.
$script:RunnerBuild = Get-CtgBuildId

Write-Host "iam-engine runner $AgentId (build $script:RunnerBuild) polling $AppUrl every ${PollSeconds}s" -ForegroundColor Cyan
while ($true) {
    try {
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; version = $script:RunnerBuild }
        if ($hb.enabled -eq $false) { Write-Warning "agent disabled server-side; stopping."; break }
        if ($hb.update -eq $true) { Update-CtgRunner }  # operator requested self-update — re-pull + restart (never returns)
        if ($hb.discover -eq $true) { Invoke-CtgAdDiscovery }  # operator requested AD OU/group discovery
        $jobs = Invoke-AppApi POST '/api/jobs/claim' @{ agentId = $AgentId; batchSize = $BatchSize }

        foreach ($job in @($jobs)) {
            $creds = @{}  # in scope for the catch's secret-scrub even if broking/execution throws early
            $script:Phase = 'starting'  # what we're doing now — the catch reports WHICH phase failed
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
                Set-CtgPhase $job.id 'brokering credentials'
                foreach ($sn in @($job.secretNames)) { if ($sn) { $creds[$sn] = Get-JobCredential $job.id $sn } }

                # Connect once per (system|tenant) before the first job that needs it. Mark the key
                # connected ONLY after Connect succeeds — a throw here (bad cred, unreachable on-prem
                # Exchange, transient) must NOT poison the cache, or every later job in this long-lived
                # process would skip Connect and run unconnected (e.g. "Get-RemoteMailbox not recognized").
                if ($handler.ContainsKey('Connect')) {
                    $tenant = if ($job.client) { $job.client.primaryDomain } else { '' }
                    $key = "$($job.systemKey)|$tenant"
                    if (-not $script:Connected.Contains($key)) {
                        Set-CtgPhase $job.id "connecting to $($job.systemKey)"
                        & $handler.Connect $job $creds
                        [void]$script:Connected.Add($key)
                    }
                }

                $dryRun = [bool]$job.dryRun
                Set-CtgPhase $job.id "$($job.action) $($job.systemKey)$(if ($dryRun) { ' (dry run)' })"
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
                # Walk the FULL inner-exception chain (deduped) so the real cause surfaces — a generic
                # outer like "Authentication failed, see inner exception" usually wraps the actual
                # logon/LDAP error (e.g. "The user name or password is incorrect", "account locked").
                $chain = [System.Collections.Generic.List[string]]::new()
                $ex = $_.Exception
                while ($ex) { if ($ex.Message) { [void]$chain.Add($ex.Message) }; $ex = $ex.InnerException }
                $msg = (($chain | Select-Object -Unique) -join ' <- ')
                if (-not $msg) { $msg = $_.Exception.GetType().Name }
                # Name the phase that failed ("while connecting to on-prem Exchange (…): Unauthorized")
                # so the operator sees WHAT broke, not just the bare provider message.
                $where = if ($script:Phase) { " while $($script:Phase)" } else { "" }
                # Scrub any brokered secret value the exception may have echoed before it's persisted.
                $err = Protect-CtgSecretsInText "[$($job.systemKey)]$($where): $msg" $creds
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
