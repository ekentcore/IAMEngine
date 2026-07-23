#Requires -Version 7.0
<#
.SYNOPSIS
    Runner POOL supervisor. Runs N iam-engine runner PROCESSES on one box for redundancy, peer-restart,
    and PARALLEL job execution — each a full, unchanged Start-IamRunner.ps1 with its OWN distinct
    server-minted agentId, at equal priority + the same scope/client.

.DESCRIPTION
    This is a thin process manager on top of primitives that already exist. It does NOT reinvent
    failover or the claim protocol:

      * The app's atomic claim (web/lib/jobs/runner-service.ts) already load-balances across
        EQUAL-priority, SAME-scope peers keyed on agentId, race-safe — so N members with DISTINCT
        agentIds are admitted as concurrent peers and split the queue with NO web change. Two members
        sharing one agentId would double-execute every job; distinct ids are the correctness boundary
        (see Coretelligent.Pool / Resolve-CtgPoolMembers).
      * Parallel EXECUTION is only safe because feature #4's concurrency governor caps in-flight
        (clientId, systemKey) <= 1 across agents. Without it, two members could run the same tenant+
        system at once (incident UM0029840 across processes). So this supervisor REFUSES -PoolSize > 1
        while the app reports governorActive=false (the S7 contract), running a single member instead,
        and scales up automatically once the governor turns on.
      * Each member is one PowerShell session = its own process-wide Coretelligent.* connections, torn
        down per job. Parallelism is across PROCESSES only — never threads/runspaces inside a runner.

    Responsibilities, and only these: resolve N member identities (lazy-enroll once via POST /api/agents,
    persist to .runner-pool.json, reuse across restarts); spawn each member detached; monitor them with
    the pure Get-CtgKeepAliveAction and peer-restart a dead/wedged one; own self-update for the whole
    pool (pull ONCE, converge staggered — no thundering herd); adopt live members on a supervisor
    restart (never double-spawn). It never claims, never brokers credentials, holds no client state.

    PoolSize=1 note: the installers launch Start-IamRunner.ps1 DIRECTLY at size 1 (byte-identical to
    today's single-agent install) and only route through this supervisor at size > 1. Running this at
    size 1 is supported (one member) but not what the size-1 installs do.

.EXAMPLE
    pwsh -File Start-IamRunnerPool.ps1 -AppUrl https://iam.example.com -AgentId cmq585... -PoolSize 3 -EnrollToken <tok>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppUrl,
    [Parameter(Mandatory)][string]$AgentId,                 # the anchor = member #0 (already enrolled by the installer)
    [int]$PoolSize = 1,
    [string]$ApiToken = $env:RUNNER_API_TOKEN,              # bearer for the app's runner APIs (heartbeat/claim/broker), passed to members
    [string]$EnrollToken = $env:RUNNER_ENROLL_TOKEN,        # signed enroll token to mint members #1..N-1 (carries scope+client); optional
    [string]$Scope = 'central',                             # fallback enroll scope when no EnrollToken (must be central|client_network)
    [string]$ClientSlug = '',                               # fallback enroll client for a client_network pool
    [int]$PollSeconds = 5,
    [int]$BatchSize = 5,
    [string]$ExoModuleVersion = '3.9.2',
    [int]$StallTimeoutSeconds = 600,
    [int]$CheckIntervalSeconds = 30,                        # how often to health-check + reconcile members
    [int]$StaggerMilliseconds = 1500,                       # gap between member cold-starts (avoid a heavy Import-Module herd)
    [string]$RunnerDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { if (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'PlainText' } } catch { }

Import-Module (Join-Path $RunnerDir 'lib/Coretelligent.Watchdog/Coretelligent.Watchdog.psm1') -Force
Import-Module (Join-Path $RunnerDir 'lib/Coretelligent.Pool/Coretelligent.Pool.psm1') -Force
. (Join-Path $RunnerDir 'lib/CtgUpdate.ps1')   # Invoke-CtgManifestPull — pull once for the whole pool

$script:MemberScript = Join-Path $RunnerDir 'Start-IamRunner.ps1'
if (-not (Test-Path -LiteralPath $script:MemberScript)) { throw "member runner not found at $($script:MemberScript) — check -RunnerDir." }
$script:RosterPath   = Join-Path $RunnerDir '.runner-pool.json'
$script:SupLockPath  = Join-Path $RunnerDir '.runner-pool.lock'
$script:UpdateSentinel = Join-Path $RunnerDir '.runner-pool.update'
$script:LogPath = if ($env:RUNNER_LOG) { $env:RUNNER_LOG } else { Join-Path $HOME 'iam-runner.log' }
$script:PwshPath = (Get-Process -Id $PID).Path; if (-not $script:PwshPath) { $script:PwshPath = (Get-Command pwsh).Source }
$script:HostName = try { [System.Net.Dns]::GetHostName() } catch { $env:COMPUTERNAME }
if (-not $script:HostName) { $script:HostName = 'runner' }
# Capture OUR OWN supervised state NOW: Start-PoolMember sets $env:RUNNER_SUPERVISED='1' (so Windows
# child members inherit it), which mutates this process's env too — so Restart-PoolSupervisor must read
# this snapshot, not the live env, or a hand-started (unsupervised) pool would wrongly exit-without-respawn.
$script:Supervised = [bool]$env:RUNNER_SUPERVISED

function Write-PoolLog([string]$Message) {
    $line = "[$([DateTime]::Now.ToString('o'))] pool-supervisor(pid $PID): $Message"
    Write-Host $line
    try { Add-Content -LiteralPath $script:LogPath -Value $line } catch { }
}

function Invoke-PoolApi {
    # Low-frequency control-plane calls (heartbeat for governor/update, enroll). Plain Invoke-RestMethod
    # (the supervisor isn't hot); ngrok-skip bypasses the ngrok-free interstitial (harmless elsewhere).
    param([string]$Method, [string]$Path, $Body)
    $headers = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $headers['Authorization'] = "Bearer $ApiToken" }
    $json = if ($Body) { ($Body | ConvertTo-Json -Depth 12) } else { $null }
    return Invoke-RestMethod -Method $Method -Uri "$AppUrl$Path" -Headers $headers -Body $json -ContentType 'application/json' -TimeoutSec 30
}

# --- supervisor single-instance guard (so two supervisors don't both manage one roster) --------------
function Test-SupersededSupervisor {
    # Fail-open: on any lock read error, keep running (better than a false self-terminate).
    try {
        if (Test-Path -LiteralPath $script:SupLockPath) {
            $owner = ([System.IO.File]::ReadAllText($script:SupLockPath)).Trim()
            if ($owner -and $owner -ne [string]$PID -and (Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue)) { return $true }
        }
    } catch { }
    return $false
}
if (Test-SupersededSupervisor) { Write-PoolLog "another pool supervisor is already running; exiting."; exit 0 }
try { [System.IO.File]::WriteAllText($script:SupLockPath, [string]$PID) } catch { }

# --- governor gate (S7): read governorActive off a lightweight heartbeat as the anchor ---------------
function Get-PoolGovernorActive {
    # Heartbeat as the anchor, but OMIT version/semver/capabilities so we never clobber member #0's
    # reported build or on-prem caps (the route uses `version ?? agent.version` and treats an absent
    # capabilities field as "not reported" -> no overwrite). Returns @{ governor; update; restart;
    # migrate }. Fails SAFE: any error -> governor=$false (single-runner safe) so a blip can't
    # accidentally admit an ungoverned pool.
    try {
        $hb = Invoke-PoolApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; appUrl = $AppUrl }
        return @{
            governor = [bool]($hb.PSObject.Properties['governorActive'] -and $hb.governorActive)
            update   = ($hb.update -eq $true)
            restart  = ($hb.restart -eq $true)
            migrate  = if ($hb.migrate -and $hb.migrate.appUrl) { [string]$hb.migrate.appUrl } else { $null }
        }
    } catch {
        Write-PoolLog "governor/heartbeat read failed ($($_.Exception.Message)) — assuming governor INACTIVE (single-runner safe)"
        return @{ governor = $false; update = $false; restart = $false; migrate = $null }
    }
}

function Resolve-EffectivePoolSize {
    param([bool]$GovernorActive)
    if ($PoolSize -le 1) { return 1 }
    if (-not $GovernorActive) {
        Write-PoolLog "REFUSING -PoolSize ${PoolSize}: the concurrency governor (feature #4) is NOT active. Running a SINGLE member. Without the governor, two members can run the same tenant+system concurrently (incident UM0029840 across processes). Turn on the governor in Settings > Concurrency and the pool scales up on its own."
        return 1
    }
    return $PoolSize
}

# --- member enrollment (lazy, once per index; persisted) ---------------------------------------------
function New-PoolMemberAgent {
    param([int]$Index)
    $name = Get-CtgPoolMemberName -HostName $script:HostName -Index $Index
    $body = @{ name = $name }
    if ($EnrollToken) { $body['enrollToken'] = $EnrollToken }
    else { $body['scope'] = $Scope; if ($ClientSlug) { $body['clientSlug'] = $ClientSlug } }
    $resp = Invoke-PoolApi POST '/api/agents' $body
    $id = [string]$resp.id
    if (-not $id) { throw "enrollment returned no agent id" }
    Write-PoolLog "enrolled pool member #$Index as '$name' -> $id"
    return $id
}

function Resolve-Members {
    # Build the member list for the effective size, enrolling + persisting any new index. A member that
    # can't enroll this cycle (app down / no token) is returned WITHOUT an agentId; the caller skips
    # spawning it and it's retried next loop (the anchor never needs enrolling, so the pool always has
    # at least one working member).
    param([int]$EffectiveSize)
    $roster = Read-CtgPoolRoster -Path $script:RosterPath
    $members = Resolve-CtgPoolMembers -PoolSize $EffectiveSize -AnchorAgentId $AgentId -Roster $roster
    $dirty = $false
    foreach ($m in $members) {
        if ($m.needsEnroll -and -not $m.agentId) {
            try { $m.agentId = New-PoolMemberAgent -Index $m.index; $m.needsEnroll = $false; $dirty = $true }
            catch { Write-PoolLog "could not enroll member #$($m.index) yet ($($_.Exception.Message)); will retry" }
        }
    }
    if ($dirty) { [void](Write-CtgPoolRoster -Path $script:RosterPath -Members ($members | Where-Object { $_.agentId })) }
    # Annotate each member with its lock + heartbeat paths for monitoring.
    foreach ($m in $members) {
        if (-not $m.agentId) { continue }
        $m['lockPath']      = Get-CtgPoolLockPath -RunnerDir $RunnerDir -AgentId $m.agentId
        $m['heartbeatPath'] = Get-CtgHeartbeatPath -AgentId $m.agentId
    }
    return $members
}

# --- member process control --------------------------------------------------------------------------
function Get-PoolMemberPid {
    # The live PID for a member: its per-agent lock file first, else find the process by command line
    # (matched on AgentId). $null when none is running. Mirrors Keep-IamRunnerAlive/Get-RunnerPid.
    param($Member)
    try {
        if (Test-Path -LiteralPath $Member.lockPath) {
            $p = ([System.IO.File]::ReadAllText($Member.lockPath)).Trim()
            if ($p -and (Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue)) { return [int]$p }
        }
    } catch { }
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='pwsh'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'Start-IamRunner\.ps1' -and $_.CommandLine -match [regex]::Escape($Member.agentId) }
        if ($procs) { return [int]($procs | Select-Object -First 1).ProcessId }
    } catch { }
    try {
        $found = & pgrep -f "Start-IamRunner\.ps1.*$([regex]::Escape($Member.agentId))" 2>$null | Select-Object -First 1
        if ($found) { return [int]$found }
    } catch { }
    return $null
}

function Start-PoolMember {
    # Launch one member DETACHED, supervised by US (RUNNER_SUPERVISED=1) and flagged as a pool member
    # (RUNNER_POOL_MEMBER=1 -> it yields self-update to us). Reuses the Keep-IamRunnerAlive launch
    # pattern: Windows hidden Start-Process; Unix a self-deleting 0700 launcher (the token rides in it).
    param($Member)
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:MemberScript, '-AppUrl', $AppUrl, '-AgentId', $Member.agentId,
        '-PollSeconds', "$PollSeconds", '-BatchSize', "$BatchSize", '-ExoModuleVersion', $ExoModuleVersion, '-StallTimeoutSeconds', "$StallTimeoutSeconds")
    if ($ApiToken) { $a += @('-ApiToken', $ApiToken) }
    $env:RUNNER_SUPERVISED = '1'
    $env:RUNNER_POOL_MEMBER = '1'
    Write-PoolLog "starting member #$($Member.index) ($($Member.agentId))"
    if ($IsWindows) {
        Start-Process -FilePath $script:PwshPath -ArgumentList $a -WindowStyle Hidden | Out-Null
    }
    else {
        $q = { param($s) "'" + ([string]$s -replace "'", "'\''") + "'" }
        $line = (@($script:PwshPath) + $a | ForEach-Object { & $q $_ }) -join ' '
        # Per-launch 0700 dir so the embedded token isn't world-readable even briefly; launcher deletes itself.
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("iam-pool-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        & chmod 700 $dir 2>$null
        $launcher = Join-Path $dir 'launch.sh'
        [System.IO.File]::WriteAllText($launcher, "#!/bin/sh`nexport RUNNER_SUPERVISED=1`nexport RUNNER_POOL_MEMBER=1`nrm -f `"`$0`" 2>/dev/null; rmdir -- `"$dir`" 2>/dev/null`nexec $line >> $(& $q $script:LogPath) 2>&1`n")
        & chmod 600 $launcher 2>$null
        Start-Process -FilePath '/bin/sh' -ArgumentList $launcher | Out-Null
    }
}

function Stop-PoolMember {
    param($Member)
    $mp = Get-PoolMemberPid $Member
    if (-not $mp) { return }
    Write-PoolLog "stopping member #$($Member.index) (pid $mp)"
    try { Stop-Process -Id $mp -Force -ErrorAction Stop } catch { Write-PoolLog "couldn't stop pid ${mp}: $($_.Exception.Message)" }
}

# --- supervisor self-relaunch (after a pool update, or an operator restart) ---------------------------
function Restart-PoolSupervisor {
    param([string]$Reason = 'restart')
    if ($script:Supervised) {
        Write-PoolLog "${Reason}: supervised — exiting so the service manager relaunches the pool supervisor"
        exit 0
    }
    # Unsupervised (hand-started): self-spawn a fresh supervisor, then exit — mirrors Invoke-CtgRelaunch.
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RunnerDir 'Start-IamRunnerPool.ps1'),
        '-AppUrl', $AppUrl, '-AgentId', $AgentId, '-PoolSize', "$PoolSize", '-PollSeconds', "$PollSeconds",
        '-BatchSize', "$BatchSize", '-ExoModuleVersion', $ExoModuleVersion, '-StallTimeoutSeconds', "$StallTimeoutSeconds",
        '-CheckIntervalSeconds', "$CheckIntervalSeconds")
    if ($ApiToken) { $a += @('-ApiToken', $ApiToken) }
    if ($EnrollToken) { $a += @('-EnrollToken', $EnrollToken) }
    Write-PoolLog "${Reason}: unsupervised — self-spawning a fresh pool supervisor"
    try {
        if ($IsWindows) { Start-Process -FilePath $script:PwshPath -ArgumentList $a -WindowStyle Hidden | Out-Null }
        else { Start-Process -FilePath $script:PwshPath -ArgumentList $a | Out-Null }
    } catch { Write-PoolLog "self-spawn failed: $($_.Exception.Message)" }
    exit 0
}

# --- pool self-update (supervisor-owned; pull ONCE, converge staggered — no thundering herd) ---------
function Invoke-PoolUpdate {
    # Pull the new bundle ONCE into the shared folder, stop every member, then relaunch the supervisor.
    # On the supervisor's fresh start (new code) it re-spawns all members STAGGERED — so the pool
    # converges to one build with no N-way pull race and no simultaneous cold-start herd.
    Write-PoolLog "pool self-update: pulling the new bundle once for all members"
    try {
        $m = Invoke-CtgManifestPull -AppUrl $AppUrl -ApiToken $ApiToken -RunnerDir $RunnerDir
        Write-PoolLog "pool self-update: pulled $($m.count) files (build $($m.buildId))"
    } catch {
        Write-PoolLog "pool self-update PULL failed ($($_.Exception.Message)) — leaving the pool on the current build; will retry"
        try { Remove-Item -LiteralPath $script:UpdateSentinel -Force -ErrorAction SilentlyContinue } catch { }
        return
    }
    try { Remove-Item -LiteralPath $script:UpdateSentinel -Force -ErrorAction SilentlyContinue } catch { }
    foreach ($m in $script:Members) { if ($m.agentId) { Stop-PoolMember $m } }
    Start-Sleep -Seconds 1
    Restart-PoolSupervisor -Reason 'pool-self-update'   # comes back on new code + re-spawns members staggered
}

# --- startup: gate on governor, resolve members, adopt-or-spawn (staggered) --------------------------
$gate = Get-PoolGovernorActive
$script:Effective = Resolve-EffectivePoolSize -GovernorActive $gate.governor
Write-PoolLog "starting pool: requested size $PoolSize, effective $($script:Effective) (governor active: $($gate.governor)); anchor $AgentId; check ${CheckIntervalSeconds}s"
$script:Members = Resolve-Members -EffectiveSize $script:Effective

$spawned = 0
foreach ($m in $script:Members) {
    if (-not $m.agentId) { continue }
    if (Get-PoolMemberPid $m) { Write-PoolLog "member #$($m.index) ($($m.agentId)) already alive — adopting"; continue }
    if ($spawned -gt 0) { Start-Sleep -Milliseconds $StaggerMilliseconds }   # stagger cold-starts
    Start-PoolMember $m
    $spawned++
}

# --- monitor loop ------------------------------------------------------------------------------------
while ($true) {
    Start-Sleep -Seconds $CheckIntervalSeconds
    try {
        # Superseded by a newer supervisor? Step aside (it now owns the roster + members).
        if (Test-SupersededSupervisor) { Write-PoolLog "a newer pool supervisor took over — exiting this one."; exit 0 }
        try { [System.IO.File]::WriteAllText($script:SupLockPath, [string]$PID) } catch { }

        # Control-plane read (governor / update / restart / migrate).
        $gate = Get-PoolGovernorActive

        # Self-update: either the operator/auto-update told the anchor, or a member dropped the sentinel.
        if ($gate.update -or (Test-Path -LiteralPath $script:UpdateSentinel)) { Invoke-PoolUpdate }   # never returns (relaunches)
        if ($gate.restart) { Write-PoolLog "operator restart requested — relaunching the pool"; Restart-PoolSupervisor -Reason 'operator-restart' }
        if ($gate.migrate -and $gate.migrate.TrimEnd('/') -ine ([string]$AppUrl).TrimEnd('/')) {
            # The members rewrite the supervisor entry (via their own Invoke-CtgMigrate); we just switch
            # our in-memory URL + relaunch so the pool supervisor doesn't stay stranded on the old host.
            Write-PoolLog "app migrated to $($gate.migrate) — switching + relaunching the pool supervisor"
            $AppUrl = $gate.migrate
            Restart-PoolSupervisor -Reason 'app-migrate'
        }

        # Re-evaluate effective size (auto scale-up once the governor turns on; scale-down if it turns off).
        $newEffective = Resolve-EffectivePoolSize -GovernorActive $gate.governor
        if ($newEffective -ne $script:Effective) {
            Write-PoolLog "effective pool size changing $($script:Effective) -> $newEffective (governor active: $($gate.governor))"
            if ($newEffective -lt $script:Effective) {
                # Scale down: stop members at dropped indices.
                foreach ($m in $script:Members) { if ($m.agentId -and $m.index -ge $newEffective) { Stop-PoolMember $m } }
            }
            $script:Effective = $newEffective
        }
        $script:Members = Resolve-Members -EffectiveSize $script:Effective

        # Per-member health + peer-restart, reusing the pure Get-CtgKeepAliveAction decision.
        $restarts = 0
        foreach ($m in $script:Members) {
            if (-not $m.agentId) { continue }   # not enrolled yet — retried above next loop
            $mp = Get-PoolMemberPid $m
            $health = Test-CtgRunnerHealth -Path $m.heartbeatPath -TimeoutSeconds $StallTimeoutSeconds
            $decision = Get-CtgKeepAliveAction -ProcessAlive ([bool]$mp) -Health $health
            if ($decision.action -eq 'ok') { continue }
            Write-PoolLog "member #$($m.index) ($($m.agentId)) -> RESTART: $($decision.reason)"
            if ($mp) { Stop-PoolMember $m; Start-Sleep -Seconds 2 }   # kill a wedged-but-alive member first
            if ($restarts -gt 0) { Start-Sleep -Milliseconds $StaggerMilliseconds }   # stagger multi-member recovery
            Start-PoolMember $m
            $restarts++
        }
    }
    catch { Write-PoolLog "monitor loop error (continuing): $($_.Exception.Message)" }
}
