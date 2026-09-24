#Requires -Version 7.0

# Coretelligent.DirectorySync
# Triggers an Azure AD Connect delta sync so an on-prem AD change (create/disable/group) flows
# up to Entra/365. Runs after `active-directory` on BOTH lanes for ad-synced clients. The
# ADSync cmdlets ship with Azure AD Connect and run on (or are remoted to) the AAD Connect host.
# Idempotent: never starts a second cycle while one is in progress.

Set-StrictMode -Version Latest

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Make the ADSync cmdlets available. They ship with Azure AD Connect but aren't on the default
# PSModulePath, and the module is a Windows PowerShell module — under PowerShell 7 it needs the
# compatibility shim. Try by name, then the WinPS compat load, then the standard install path.
# Returns $true if Get-ADSyncScheduler is callable afterward. Throws a clear, host-pointed error at
# the call sites when it can't be loaded (i.e. Azure AD Connect isn't installed on this host).
function Initialize-CtgADSync {
    # DETECTION ONLY — is Azure AD Connect (ADSync) installed on THIS host? Never LOAD it here. Loading
    # the ADSync module in pwsh 7 forces a Windows-PowerShell-compat session (the module is Desktop-only),
    # whose loopback WinRM init throws "Could not load type 'System.Web...'" on .NET Core — and that error
    # escapes and surfaces as the step failure. The actual load+run happens in Invoke-CtgAdSyncLocal, in
    # Windows PowerShell 5.1 (.NET Framework), where ADSync loads natively. Returns $true when ADSync is
    # local (already loaded, on the module path, or at the standard install path); $false -> remote host.
    if (Get-Command Get-ADSyncScheduler -ErrorAction SilentlyContinue) { return $true }   # already loaded (or a test stub)
    if (Get-Module -ListAvailable -Name ADSync -ErrorAction SilentlyContinue) { return $true }
    if (Test-Path -LiteralPath "$env:ProgramFiles\Microsoft Azure AD Sync\Bin\ADSync\ADSync.psd1" -ErrorAction SilentlyContinue) { return $true }
    return $false
}

# Run a LOCAL ADSync scriptblock (the sync trigger, or the scheduler read) on THIS host — the Entra
# Connect server. Try in-process first (works in tests, and where pwsh 7 can load ADSync); on the .NET
# Core gap — pwsh 7 can't load the Desktop-only ADSync module without a WinPS-compat session, whose
# loopback WinRM throws "Could not load type 'System.Web...'" — retry the SAME scriptblock in Windows
# PowerShell 5.1 (.NET Framework), which loads ADSync natively. Local counterpart of Invoke-CtgAdSyncRemote.
function Invoke-CtgAdSyncLocal {
    [CmdletBinding()]
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock)
    try { return & $ScriptBlock }
    catch {
        $err = $_
        $full = "$err"; $e = $err.Exception; while ($e) { if ($e.Message) { $full += " | $($e.Message)" }; $e = $e.InnerException }
        $winPS = $null
        if (($PSVersionTable.PSEdition -eq 'Core') -and $IsWindows) {
            $candidate = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            if (Test-Path $candidate) { $winPS = $candidate }
        }
        if (-not $winPS) { throw "directory-sync local ADSync run failed and no Windows PowerShell 5.1 fallback is available (edition=$($PSVersionTable.PSEdition), windows=$IsWindows): $full" }
        $inner = "`$ErrorActionPreference='Stop'; `$r = & { $($ScriptBlock.ToString()) }; `$r | ConvertTo-Json -Compress -Depth 6"
        $out = & $winPS -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $inner 2>&1
        if ($LASTEXITCODE -ne 0) { throw "directory-sync ran ADSync locally under Windows PowerShell 5.1 (pwsh 7 can't load the Desktop-only ADSync module: $full) and 5.1 ALSO failed: $out" }
        $line = (@($out) | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Last 1)
        if (-not $line) { return $null }
        try { return (ConvertFrom-Json $line) } catch { return $line }
    }
}

# Auto-discover the Entra Connect server from AD — no hard-coding. Azure AD Connect creates a sync
# account (legacy MSOL_*, newer AAD_*) whose Description records the install host:
# "...running on computer <NAME> configured to synchronize to tenant...". We read that and return an
# FQDN. Needs the ActiveDirectory module (present on the DC agent) + a credential to read AD.
function Find-CtgADSyncHost {
    [CmdletBinding()]
    param([pscredential]$Credential)
    if (-not (Get-Command Get-ADUser -ErrorAction SilentlyContinue)) {
        try { Import-Module ActiveDirectory -ErrorAction Stop } catch { return $null }
    }
    $p = @{ Filter = "samAccountName -like 'MSOL_*' -or samAccountName -like 'AAD_*'"; Properties = 'Description'; ErrorAction = 'Stop' }
    if ($Credential) { $p.Credential = $Credential }
    try { $accts = @(Get-ADUser @p) } catch { return $null }
    foreach ($a in $accts) {
        if ($a.Description -and $a.Description -match 'running on computer (\S+)') {
            $name = $matches[1].TrimEnd('.', ',')
            if ($name -notmatch '\.') {
                $domP = @{ ErrorAction = 'SilentlyContinue' }; if ($Credential) { $domP.Credential = $Credential }
                $dom = (Get-ADDomain @domP).DNSRoot
                if ($dom) { $name = "$name.$dom" }
            }
            return $name
        }
    }
    return $null
}

# Resolve whether to run ADSync locally or remote into the Entra Connect host. Returns
# @{ Remote; Host; Discovered }. Local when ADSync is installed here. Otherwise (Model A: one DC
# runner) remote into the host — taken from config.host if set, else auto-discovered from AD.
function Resolve-CtgADSyncTarget {
    param([string]$SyncHost, [pscredential]$Credential)
    if (Initialize-CtgADSync) { return @{ Remote = $false; Host = $null; Discovered = $false } }
    $discovered = $false
    $h = $SyncHost
    if (-not $h) { $h = Find-CtgADSyncHost -Credential $Credential; if ($h) { $discovered = $true } }
    if (-not $h) {
        throw "the ADSync module (Azure AD Connect) isn't installed on this host, and the Entra Connect server couldn't be auto-discovered from AD. Set the directory-sync 'host' explicitly, or make sure the MSOL_/AAD_ sync account is readable."
    }
    if (-not $Credential) {
        throw "remoting to the Entra Connect host '$h' needs a credential — add the ad-dc secret to the directory-sync step so it's brokered (and that account must be allowed to run ADSync on $h)."
    }
    return @{ Remote = $true; Host = $h; Discovered = $discovered }
}

# WinRM remoting with an explicit credential FAILS under pwsh 7 (.NET Core): the NTLM/Negotiate auth
# path reaches for 'System.Web.Util.Utf16StringValidator', and System.Web isn't in .NET Core -> "Could
# not load type ... System.Web". Windows PowerShell 5.1 (.NET Framework) HAS that assembly. So: try
# in-process first (works under 5.1, or under pwsh 7 where Kerberos/config avoids that path), and on
# THAT specific assembly-load failure retry the SAME Invoke-Command under Windows PowerShell 5.1. The
# credential is handed to the 5.1 child via a DPAPI-protected CLIXML file — encrypted for the current
# account (the runner's SYSTEM), which is the same account the child runs as on the same box, so it
# decrypts there and never touches disk in cleartext. Only the failing call drops to 5.1; the runner
# stays on pwsh 7. A non-assembly error (real auth/connectivity) is re-thrown unchanged, not masked.
function Invoke-CtgAdSyncRemote {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ComputerName, [Parameter(Mandatory)][pscredential]$Credential, [Parameter(Mandatory)][scriptblock]$ScriptBlock)
    try {
        return Invoke-Command -ComputerName $ComputerName -Credential $Credential -ScriptBlock $ScriptBlock -ErrorAction Stop
    } catch {
        $err = $_
        # Full text (whole inner chain) for diagnostics.
        $full = "$err"
        $e = $err.Exception
        while ($e) { if ($e.Message) { $full += " | $($e.Message)" }; $e = $e.InnerException }
        # BROADENED: retry ANY pwsh-7-on-Windows remote failure under Windows PowerShell 5.1, not just a
        # matched 'System.Web' string. pwsh 7 (.NET Core) can't WinRM-with-a-credential (the NTLM/Negotiate
        # path needs System.Web, which .NET Core lacks); 5.1 (.NET Framework) can. If the real problem is
        # auth/connectivity (not the assembly gap), 5.1 just re-fails and we surface THAT — never the opaque
        # System.Web load error. Only skip the retry where 5.1 can't exist (non-Windows / non-Core).
        $winPS = $null
        if (($PSVersionTable.PSEdition -eq 'Core') -and $IsWindows) {
            $candidate = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            if (Test-Path $candidate) { $winPS = $candidate }
        }
        if (-not $winPS) { throw "directory-sync remote failed and no Windows PowerShell 5.1 fallback is available here (edition=$($PSVersionTable.PSEdition), windows=$IsWindows): $full" }
        $credFile = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-adsync-" + [guid]::NewGuid().ToString('N') + ".xml")
        try {
            $Credential | Export-Clixml -Path $credFile
            # The remote ScriptBlock is our own fixed ADSync script (no $-vars), embedded as text; the
            # child's OWN vars are backtick-escaped so the outer pwsh doesn't expand them. The child emits
            # its result as compact JSON so a structured return (the validator's @{Enabled;InProgress})
            # survives the process boundary; a bare string ('started') round-trips as "started".
            $inner = "`$ErrorActionPreference='Stop'; `$c = Import-Clixml -LiteralPath '$credFile'; " +
                     "`$r = Invoke-Command -ComputerName '$ComputerName' -Credential `$c -ScriptBlock { $($ScriptBlock.ToString()) }; " +
                     "`$r | ConvertTo-Json -Compress -Depth 6"
            $out = & $winPS -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $inner 2>&1
            if ($LASTEXITCODE -ne 0) { throw "directory-sync retried under Windows PowerShell 5.1 (pwsh 7 remote failed: $full) and 5.1 ALSO failed on '$ComputerName': $out" }
            $line = (@($out) | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Select-Object -Last 1)
            if (-not $line) { return $null }
            try { return (ConvertFrom-Json $line) } catch { return $line }
        } finally {
            Remove-Item -LiteralPath $credFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# Wait for a delta sync cycle to FINISH, rather than assuming it has (FR #0000112).
#
# Invoke-CtgDirectorySync used to fire Start-ADSyncSyncCycle and return immediately, so the m365 step
# looked the account up before Entra Connect had written it — the "no synced M365 account for ..."
# failures. FR #0000105 was the mirror image of this (a synced account misread once it DID exist).
#
# A bounded POLL, not a flat sleep: it returns as soon as the cycle settles (usually far sooner than a
# fixed delay) and is honest when the sync genuinely has not finished. Same shape as Wait-CtgMailbox.
#
# THE RACE THIS HANDLES: Start-ADSyncSyncCycle returns before the scheduler reports the cycle as
# running. Probing immediately would see SyncCycleInProgress=$false and declare it complete — which is
# precisely the bug being fixed, reintroduced. So a cycle WE started waits one interval before the
# first probe; one already in progress when we arrived is probed straight away.
#
# $ProbeArgs exists because the caller's probe MUST NOT be a closure. A scriptblock built in this module
# resolves commands in this module; .GetNewClosure() re-hosts it in a fresh dynamic module where the
# private helpers (Invoke-CtgAdSyncLocal/Remote, neither exported) cannot be found, so every probe threw
# CommandNotFound, which this function then reported as 'unknown' — "probably fine" — and the wait FR
# #0000112 added silently never waited (FR #0000127). The probe now takes what it needs as arguments and
# stays bound to this module.
function Wait-CtgADSyncComplete {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock]$Probe,   # $true while a cycle is running
        [object[]]$ProbeArgs = @(),                  # passed to $Probe — keeps it a plain, module-bound scriptblock
        [int]$TimeoutSeconds = 120,
        [int]$IntervalSeconds = 10,
        [switch]$SettleFirst                          # we just started it — let the scheduler catch up
    )
    $start = Get-Date
    $deadline = $start.AddSeconds($TimeoutSeconds)
    if ($SettleFirst) { Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, $TimeoutSeconds)) }
    while ($true) {
        $running = $false
        try { $running = [bool](& $Probe @ProbeArgs) }
        catch {
            # A probe failure is not a sync failure — the cycle may well be fine. Stop waiting and say so
            # rather than burning the whole budget on a host we cannot read.
            return [pscustomobject]@{ Status = 'unknown'; WaitedSeconds = [int]((Get-Date) - $start).TotalSeconds; Error = $_.Exception.Message }
        }
        if (-not $running) { return [pscustomobject]@{ Status = 'completed'; WaitedSeconds = [int]((Get-Date) - $start).TotalSeconds } }
        if ((Get-Date) -ge $deadline) { return [pscustomobject]@{ Status = 'timeout'; WaitedSeconds = [int]((Get-Date) - $start).TotalSeconds } }
        if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) {
            $elapsed = [int]((Get-Date) - $start).TotalSeconds
            $remain = [int]($deadline - (Get-Date)).TotalSeconds
            Send-CtgProgress "waiting for the Entra Connect delta sync to finish — ${elapsed}s elapsed (giving up in ${remain}s)"
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}

function Invoke-CtgDirectorySync {
    <#
    .SYNOPSIS
        Start an Azure AD Connect delta sync, unless one is already running. Runs where the ADSync
        module lives: locally if installed, else remoted (WinRM) into the configured Entra Connect host.
    .PARAMETER Config
        { host } — the Entra Connect server (e.g. "Core-CCE-AzSync"). Used to remote when ADSync
        isn't on this agent's host.
    .PARAMETER Credential
        Domain credential (ad-dc) used to remote into the host; must be in ADSyncOperators there.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([pscustomobject]$Config, [pscredential]$Credential)

    $actions = [System.Collections.Generic.List[string]]::new()
    $syncHost = Get-CtgProp $Config 'host'
    $target = Resolve-CtgADSyncTarget -SyncHost $syncHost -Credential $Credential
    if ($target.Remote) { $actions.Add("remoting into Entra Connect host: $($target.Host)$(if ($target.Discovered) { ' (auto-discovered from AD)' })") }

    if ($WhatIfPreference) {
        $actions.Add("dry run — would Start-ADSyncSyncCycle -PolicyType Delta$(if ($target.Remote) { " on $($target.Host)" } else { ' locally' })")
        return [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
    }

    # Self-contained for remoting (the target imports ADSync itself); local path calls the cmdlets
    # directly so unit-test mocks of Get-ADSyncScheduler/Start-ADSyncSyncCycle still apply.
    $remoteScript = {
        # ADSync isn't on the default module path (it lives under Program Files\Microsoft Azure AD*),
        # so `Import-Module ADSync` by NAME fails ("Start-ADSyncSyncCycle is not recognized"). Import it
        # by its full .psd1 path; only if the cmdlets aren't already available.
        if (-not (Get-Command Start-ADSyncSyncCycle -ErrorAction SilentlyContinue)) {
            $adm = Get-ChildItem "$env:ProgramFiles\Microsoft Azure AD*" -Recurse -Filter ADSync.psd1 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($adm) { Import-Module $adm.FullName -ErrorAction Stop } else { Import-Module ADSync -ErrorAction Stop }
        }
        if ((Get-ADSyncScheduler).SyncCycleInProgress) { 'in-progress' }
        else { Start-ADSyncSyncCycle -PolicyType Delta | Out-Null; 'started' }
    }
    $outcome =
        if ($target.Remote) { Invoke-CtgAdSyncRemote -ComputerName $target.Host -Credential $Credential -ScriptBlock $remoteScript }
        else { Invoke-CtgAdSyncLocal -ScriptBlock $remoteScript }  # Entra Connect on THIS host — in-proc, else 5.1

    $alreadyRunning = ($outcome -eq 'in-progress')
    if ($alreadyRunning) {
        # NOT "the pending change will be picked up": a cycle already running when we arrived may have
        # taken its snapshot BEFORE the AD write, in which case the change waits for the NEXT cycle. The
        # old wording stated a guess as fact (FR #0000127).
        $actions.Add("a sync cycle was already in progress — did not start another. If it began before this case's AD changes, they go up on the following cycle rather than this one.")
    } else {
        $actions.Add("started delta sync (Start-ADSyncSyncCycle -PolicyType Delta)")
    }

    # Wait for the cycle to finish before reporting success. Without this the step returned the instant
    # the cycle was TRIGGERED, and the m365 step then looked up an account Entra Connect had not written
    # yet (FR #0000112). Configurable per client; 0 turns the wait off entirely and restores the old
    # fire-and-forget behaviour.
    $waitSeconds = [int](((Get-CtgProp $Config 'waitForSyncSeconds') ?? 120))
    if ($waitSeconds -gt 0) {
        $statusScript = {
            if (-not (Get-Command Get-ADSyncScheduler -ErrorAction SilentlyContinue)) {
                $adm = Get-ChildItem "$env:ProgramFiles\Microsoft Azure AD*" -Recurse -Filter ADSync.psd1 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($adm) { Import-Module $adm.FullName -ErrorAction Stop } else { Import-Module ADSync -ErrorAction Stop }
            }
            [bool](Get-ADSyncScheduler).SyncCycleInProgress
        }
        # NOT .GetNewClosure() — see Wait-CtgADSyncComplete. A closure loses this module's scope and the
        # probe can no longer see Invoke-CtgAdSyncLocal/Remote, which is how the wait came to be inert.
        # Everything it needs arrives as an argument instead, so it stays a plain module-bound scriptblock.
        $probe = {
            param($t, $cred, $status)
            if ($t.Remote) { Invoke-CtgAdSyncRemote -ComputerName $t.Host -Credential $cred -ScriptBlock $status }
            else { Invoke-CtgAdSyncLocal -ScriptBlock $status }
        }
        $w = Wait-CtgADSyncComplete -Probe $probe -ProbeArgs @($target, $Credential, $statusScript) -TimeoutSeconds $waitSeconds -SettleFirst:(-not $alreadyRunning)
        # What each outcome is ENTITLED to say. A finished delta cycle is evidence that a cycle ran — not
        # that this user was exported: their OU may be outside the sync scope, or a sync rule may filter
        # them, and the cycle completes cleanly either way. This step has no Graph credential (it is
        # on-prem, brokered ad-dc only) so it cannot check, and must not imply that it did (FR #0000127).
        switch ($w.Status) {
            'completed' { $actions.Add("sync cycle finished after $($w.WaitedSeconds)s (this confirms the cycle ran, not that this user was included in it — verify in Entra if a later step cannot find them)") }
            'timeout'   { $actions.Add("WARN the sync cycle was still running after $($w.WaitedSeconds)s — carrying on without waiting further. A later step that cannot find the account in Entra is most likely this sync still catching up; re-run that step.") }
            default     { $actions.Add("WARN could not read the sync scheduler while waiting ($($w.Error)) — the cycle was triggered but this step never observed it finish, so nothing here confirms the sync completed.") }
        }
    }

    [pscustomobject]@{ System = 'directory-sync'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Confirm-CtgDirectorySync {
    <#
    .SYNOPSIS
        Post-action read-back for Azure AD Connect: the sync scheduler is healthy (enabled). A cycle
        that's IN PROGRESS is success, not a miss — we just triggered it. No mutations; { ok; checks }.
    #>
    [CmdletBinding()]
    param(
        [pscustomobject]$User,
        [pscustomobject]$Config,
        [ValidateSet('onboard', 'offboard')][string]$Action,
        [pscredential]$Credential
    )
    $syncHost = Get-CtgProp $Config 'host'
    # Return scheduler health, not just in-progress. Enabled = the sync mechanism is working; a cycle
    # in progress right after we triggered one is the expected, healthy state.
    $remoteScript = {
        if (-not (Get-Command Get-ADSyncScheduler -ErrorAction SilentlyContinue)) {
            $adm = Get-ChildItem "$env:ProgramFiles\Microsoft Azure AD*" -Recurse -Filter ADSync.psd1 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($adm) { Import-Module $adm.FullName -ErrorAction Stop } else { Import-Module ADSync -ErrorAction Stop }
        }
        $s = Get-ADSyncScheduler; @{ Enabled = [bool]$s.SyncCycleEnabled; InProgress = [bool]$s.SyncCycleInProgress }
    }
    try {
        $target = Resolve-CtgADSyncTarget -SyncHost $syncHost -Credential $Credential
        $state =
            if ($target.Remote) { Invoke-CtgAdSyncRemote -ComputerName $target.Host -Credential $Credential -ScriptBlock $remoteScript }
            else { Invoke-CtgAdSyncLocal -ScriptBlock $remoteScript }  # Entra Connect on THIS host — in-proc, else 5.1
    } catch {
        return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'ADSync reachable'; expected = $true; actual = $false; pass = $false }) }
    }
    $enabled = [bool]$state.Enabled
    # The check names say what was actually read. SyncCycleEnabled is a TENANT-WIDE health flag: it is
    # true whenever Entra Connect is switched on, for every case, whether or not this user ever synced.
    # Passing on it is legitimate — it is the only thing an on-prem step with no Graph credential can
    # read — but calling it "verified" let operators read a green directory-sync as "the user is in
    # Entra" (FR #0000127). Same defect FR #0000093 found in ad-consistency-check, which reported a
    # reassuring line for a comparison it had never performed (web/lib/jobs/cloud-object.ts).
    $checks = @(
        @{ name = 'Entra Connect sync mechanism healthy (scheduler enabled) — does not confirm this user reached Entra'; expected = $true; actual = $enabled; pass = $enabled },
        @{ name = 'sync cycle running (informational)'; expected = $null; actual = [bool]$state.InProgress; pass = $true }
    )
    [pscustomobject]@{ ok = $enabled; checks = $checks }
}

Export-ModuleMember -Function Invoke-CtgDirectorySync, Confirm-CtgDirectorySync, Wait-CtgADSyncComplete
