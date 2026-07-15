#Requires -Version 7.0

# Coretelligent.Browser — bridge from the PowerShell runner to the Node/Playwright browser sidecar
# (runner/browser). The runner is pure PowerShell 7 with no Node of its own; for the few systems
# with NO API, a flow under runner/browser/flows is driven by a headless Chromium. This module shells
# out to that sidecar, feeding the job spec on stdin and parsing the single JSON result on stdout.
#
# Nothing here logs a password: the spec (which may carry one) is written to the child's stdin, never
# to a log or the command line, and the child echoes back only booleans / messages / evidence paths.

Set-StrictMode -Version Latest

# Where the Node sidecar lives, relative to this module (runner/modules/Coretelligent.Browser -> runner/browser).
# Resolve a Node tool (node/npm/npx) even when PATH is the minimal one a SERVICE MANAGER hands us.
# This bit the central Mac: node lives in /usr/local/bin, but launchd's default PATH is only
# /usr/bin:/bin:/usr/sbin:/sbin — so `Get-Command node` failed, the runner silently skipped the whole
# browser sidecar, and the agent never advertised 'browser' (a Windows SYSTEM task and a systemd unit
# have exactly the same minimal-PATH problem). So: try PATH first, then the well-known install roots.
# Prepends the found directory to PATH for this process, so child tools (npm calling node) work too.
$script:CommonNodeDirs = @(
    '/usr/local/bin',                                   # macOS (Node installer), most Linux
    '/opt/homebrew/bin',                                # macOS Apple-silicon Homebrew
    '/usr/bin',
    "$env:ProgramFiles\nodejs",                         # Windows default
    "$env:LOCALAPPDATA\Programs\nodejs"
)
function Resolve-CtgNodeTool {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($dir in $script:CommonNodeDirs) {
        if (-not $dir) { continue }
        foreach ($ext in @('', '.cmd', '.exe')) {
            $candidate = Join-Path $dir "$Name$ext"
            if (Test-Path -LiteralPath $candidate) {
                # Make it discoverable to child processes too (npm shells out to node).
                if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $dir) {
                    $env:PATH = "$dir$([IO.Path]::PathSeparator)$env:PATH"
                }
                return $candidate
            }
        }
    }
    return $null
}

function Get-CtgBrowserRoot {
    Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'browser'
}

# Where Playwright caches its downloaded browser binaries (the `npx playwright install chromium`
# step, SEPARATE from `npm install`). Honors PLAYWRIGHT_BROWSERS_PATH; else the per-OS default.
function Test-CtgChromiumInstalled {
    try {
        $base =
            if ($env:PLAYWRIGHT_BROWSERS_PATH -and $env:PLAYWRIGHT_BROWSERS_PATH -ne '0') { $env:PLAYWRIGHT_BROWSERS_PATH }
            elseif ($env:PLAYWRIGHT_BROWSERS_PATH -eq '0') { Join-Path (Get-CtgBrowserRoot) 'node_modules/playwright-core/.local-browsers' } # bundled-in-node_modules mode
            elseif ($IsWindows) { Join-Path $env:LOCALAPPDATA 'ms-playwright' }
            elseif ($IsMacOS)   { Join-Path $HOME 'Library/Caches/ms-playwright' }
            else                { Join-Path $HOME '.cache/ms-playwright' }
        if (-not (Test-Path -LiteralPath $base)) { return $false }
        # A chromium install is a `chromium-<rev>` (or `chromium_headless_shell-<rev>`) directory.
        return [bool](Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'chromium*' } | Select-Object -First 1)
    } catch {
        return $false
    }
}

# Is the @playwright/test dependency ACTUALLY installed (not just a leftover directory)? An interrupted
# `npm install` can leave node_modules/@playwright/test as an EMPTY directory — enough for a bare
# `Test-Path @playwright` to pass, but the package has no code, so run-flow.mjs's `import "@playwright/
# test"` throws at ESM load and every browser job crashes before it can report why. Checking for the
# package's own package.json is the cheap, reliable signal that the package's files are really there.
# (This hollow-install state caused the 2026-07-15 fleet-wide Spanning force-sync outage.)
function Test-CtgPlaywrightInstalled {
    $pkg = Join-Path (Get-CtgBrowserRoot) 'node_modules/@playwright/test/package.json'
    return (Test-Path -LiteralPath $pkg)
}

function Test-CtgBrowserAvailable {
    <#
    .SYNOPSIS
        Is the browser-automation sidecar usable on THIS host? True only when `node` is on PATH, the
        sidecar's Playwright dependency is actually installed (node_modules/@playwright/test/package.json
        — a bare directory left by an interrupted npm install does NOT count), AND the Chromium browser
        binary is downloaded (`npx playwright install chromium` — a separate step from `npm install`, so
        checked separately or the agent would advertise 'browser' and then fail every launch). Reported
        to the app as the 'browser' capability so the claim gate withholds browser jobs from agents that
        can't run them. Never throws.
    #>
    [CmdletBinding()]
    param()
    try {
        if (-not (Resolve-CtgNodeTool 'node')) { return $false }
        if (-not (Test-CtgPlaywrightInstalled)) { return $false }
        return (Test-CtgChromiumInstalled)
    } catch {
        return $false
    }
}

# Run an external command (npm/npx/node) with a bounded timeout, draining stdout+stderr async so a
# chatty installer can't deadlock the pipe. Returns { Code; Tail }. Never throws.
function Invoke-CtgToolProcess {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory, [int]$TimeoutSeconds = 900)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill($true) } catch { }
            return [pscustomobject]@{ Code = -1; Tail = "timed out after ${TimeoutSeconds}s" }
        }
        $combined = ((($outTask.GetAwaiter().GetResult()), ($errTask.GetAwaiter().GetResult())) -join "`n").Trim()
        $tail = if ($combined.Length -gt 600) { $combined.Substring($combined.Length - 600) } else { $combined }
        return [pscustomobject]@{ Code = $proc.ExitCode; Tail = $tail }
    } catch {
        return [pscustomobject]@{ Code = -1; Tail = $_.Exception.Message }
    } finally {
        if ($proc) { $proc.Dispose() }
    }
}

# Run a Node CLI tool (npm/npx) cross-platform: on Windows npm/npx are .cmd shims that Process.Start
# can't exec directly, so go through cmd.exe /c; elsewhere run the resolved binary directly.
function Invoke-CtgNodeTool {
    param([Parameter(Mandatory)][string]$Tool, [string[]]$Arguments = @(), [string]$WorkingDirectory, [int]$TimeoutSeconds = 900)
    if ($IsWindows) {
        return Invoke-CtgToolProcess -FilePath $env:ComSpec -Arguments (@('/c', $Tool) + $Arguments) -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds
    }
    $cmd = Get-Command $Tool -ErrorAction SilentlyContinue
    if (-not $cmd) { return [pscustomobject]@{ Code = -1; Tail = "$Tool not found on PATH" } }
    return Invoke-CtgToolProcess -FilePath $cmd.Source -Arguments $Arguments -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds
}

function Install-CtgBrowser {
    <#
    .SYNOPSIS
        One-time self-heal for the browser sidecar: when `node` is present but the Playwright harness
        (runner/browser/node_modules) or the Chromium binary is missing, install them — `npm install`
        in runner/browser, then `npx playwright install chromium`. Best-effort, bounded (each step has
        a timeout), logs progress. Returns $true only if Test-CtgBrowserAvailable is true afterwards.
        Never throws — a failed install just leaves the agent without the 'browser' capability.
    #>
    [CmdletBinding()]
    param([int]$TimeoutSeconds = 900) # npm install + a cold Chromium download can take minutes
    try {
        if (-not (Resolve-CtgNodeTool 'node')) {
            Write-Warning "browser sidecar: 'node' is not on PATH — install Node 18+ to enable browser automation."
            return $false
        }
        if (-not (Resolve-CtgNodeTool 'npm')) {
            Write-Warning "browser sidecar: 'npm' is not on PATH (it ships with Node)."
            return $false
        }
        $root = Get-CtgBrowserRoot
        if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
            Write-Warning "browser sidecar directory not found ($root) — is runner/browser deployed to this host?"
            return $false
        }

        # 1. Dependencies (node_modules/@playwright/test) — skip only if REALLY present. Guard on the
        # package's package.json, not just the @playwright directory: a hollow dir from an interrupted
        # install would otherwise be treated as "done" and never repaired, stranding the sidecar.
        if (-not (Test-CtgPlaywrightInstalled)) {
            Write-Host "browser sidecar: installing npm dependencies in $root …" -ForegroundColor Yellow
            $r = Invoke-CtgNodeTool -Tool 'npm' -Arguments @('install', '--no-audit', '--no-fund') -WorkingDirectory $root -TimeoutSeconds $TimeoutSeconds
            if ($r.Code -ne 0) { Write-Warning "browser sidecar: npm install failed ($($r.Code)): $($r.Tail)"; return $false }
        }

        # 2. Chromium binary (separate download, cached in ms-playwright) — skip if already present.
        if (-not (Test-CtgChromiumInstalled)) {
            Write-Host "browser sidecar: downloading Chromium (playwright install chromium) …" -ForegroundColor Yellow
            $r = if (Resolve-CtgNodeTool 'npx') {
                Invoke-CtgNodeTool -Tool 'npx' -Arguments @('playwright', 'install', 'chromium') -WorkingDirectory $root -TimeoutSeconds $TimeoutSeconds
            } else {
                Invoke-CtgNodeTool -Tool 'npm' -Arguments @('run', 'install-browser') -WorkingDirectory $root -TimeoutSeconds $TimeoutSeconds
            }
            if ($r.Code -ne 0) { Write-Warning "browser sidecar: Chromium install failed ($($r.Code)): $($r.Tail)"; return $false }
        }

        return (Test-CtgBrowserAvailable)
    } catch {
        Write-Warning "browser sidecar install error: $($_.Exception.Message)"
        return $false
    }
}

function Invoke-CtgBrowserFlow {
    <#
    .SYNOPSIS
        Run a named browser flow via the Node sidecar and return a normalized result object:
        [pscustomobject]@{ ok=[bool]; message=[string]; error=[string]; evidence=[string];
                           retryAfterMinutes=[int|$null] }.
        Graceful: when the sidecar is unavailable it returns ok=$false with a clear message rather
        than throwing, so an executor can map it to a warning.
    .PARAMETER Flow
        The flow name (a module under runner/browser/flows, e.g. 'spanning-force-sync').
    .PARAMETER InputObject
        A hashtable { username; password; params } passed to the flow as its `input`. The password
        is written only to the child's stdin.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Flow,
        [Parameter(Mandatory)][hashtable]$InputObject,
        [int]$TimeoutSeconds = 180
    )

    if (-not (Test-CtgBrowserAvailable)) {
        return [pscustomobject]@{ ok = $false; message = $null; error = 'browser automation unavailable on this agent (Node/Playwright not installed)'; evidence = $null; retryAfterMinutes = $null }
    }

    $root   = Get-CtgBrowserRoot
    $script = Join-Path $root 'run-flow.mjs'
    if (-not (Test-Path -LiteralPath $script)) {
        return [pscustomobject]@{ ok = $false; message = $null; error = "browser sidecar entry not found ($script)"; evidence = $null; retryAfterMinutes = $null }
    }

    $spec = @{ flow = $Flow; input = $InputObject } | ConvertTo-Json -Depth 8 -Compress

    # Shell out to `node run-flow.mjs`, feeding the JSON spec on stdin and capturing stdout. Use
    # ProcessStartInfo so the spec (with the password) goes over stdin — never the command line/args
    # (which are visible in the process list) and never a temp file on disk.
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = (Resolve-CtgNodeTool 'node')
    $psi.ArgumentList.Add($script)
    $psi.WorkingDirectory       = $root
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false

    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.Write($spec)
        $proc.StandardInput.Close()
        # Drain stdout AND stderr concurrently via async reads: a synchronous ReadToEnd() on stdout
        # would block, and if Chromium fills the stderr pipe buffer (~64KB of GPU/sandbox noise) the
        # child blocks writing stderr → never closes stdout → the read never returns and the timeout
        # can't fire. Async tasks let both pipes empty while we wait, bounded, on exit.
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill($true) } catch { }
            return [pscustomobject]@{ ok = $false; message = $null; error = "browser flow '$Flow' timed out after ${TimeoutSeconds}s"; evidence = $null; retryAfterMinutes = $null }
        }
        # The process has exited, so both pipes are closed — the read tasks are complete.
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
    } catch {
        return [pscustomobject]@{ ok = $false; message = $null; error = "could not run the browser sidecar: $($_.Exception.Message)"; evidence = $null; retryAfterMinutes = $null }
    } finally {
        if ($proc) { $proc.Dispose() }
    }

    # The sidecar prints a single JSON line as its LAST stdout line (progress goes to stderr). Parse
    # the last non-empty line so any stray stdout noise before it can't break the parse.
    $line = ($stdout -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    if (-not $line) {
        $tail = if ($stderr) { " (stderr: $((($stderr -split "`n") | Select-Object -Last 3) -join ' '))" } else { '' }
        return [pscustomobject]@{ ok = $false; message = $null; error = "browser flow '$Flow' produced no result$tail"; evidence = $null; retryAfterMinutes = $null }
    }
    try {
        $parsed = $line | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ ok = $false; message = $null; error = "browser flow '$Flow' returned unparseable output: $line"; evidence = $null; retryAfterMinutes = $null }
    }

    [pscustomobject]@{
        ok                = [bool]$parsed.ok
        message           = if ($parsed.PSObject.Properties['message']) { $parsed.message } else { $null }
        error             = if ($parsed.PSObject.Properties['error'])   { $parsed.error }   else { $null }
        evidence          = if ($parsed.PSObject.Properties['evidence']) { $parsed.evidence } else { $null }
        retryAfterMinutes = if ($parsed.PSObject.Properties['retryAfterMinutes'] -and $null -ne $parsed.retryAfterMinutes) { [int]$parsed.retryAfterMinutes } else { $null }
    }
}

Export-ModuleMember -Function Test-CtgBrowserAvailable, Install-CtgBrowser, Invoke-CtgBrowserFlow, Resolve-CtgNodeTool
