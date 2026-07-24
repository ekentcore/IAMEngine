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

# Where the RUNNER-LOCAL portable Node lives: <runner>/.node/node-v<ver>-<os>-<arch>. Installed by
# Install-CtgNodeRuntime (the remote "Install browser automation" bootstrap) so a host with no system
# Node — e.g. a client DC where nobody wants to RDP in and run an installer — can still run the
# sidecar. A DOT directory on purpose: Get-CtgBuildId (and the app's bundle hash) skip dot-segments,
# so the extracted runtime never makes the agent read as "update available" forever.
function Get-CtgNodeInstallRoot {
    Join-Path (Split-Path (Get-CtgBrowserRoot) -Parent) '.node'
}

# Directories inside the local portable install that may hold node/npm/npx: the extracted folder
# itself on Windows (node.exe at the archive root) or its bin/ on Unix. Empty when nothing installed.
function Get-CtgLocalNodeDirs {
    $root = Get-CtgNodeInstallRoot
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $dirs = @()
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        $dirs += $d.FullName
        $bin = Join-Path $d.FullName 'bin'
        if (Test-Path -LiteralPath $bin) { $dirs += $bin }
    }
    return $dirs
}

function Resolve-CtgNodeTool {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Search the runner-local portable install FIRST (it exists precisely because the system dirs came
    # up empty when it was bootstrapped), then the well-known system install roots.
    foreach ($dir in @(Get-CtgLocalNodeDirs) + $script:CommonNodeDirs) {
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

# Pinned Node LTS the remote bootstrap downloads. Pinned (not "latest") so every agent that
# self-installs runs the SAME runtime we validated the flows against; override per host with
# IAM_RUNNER_NODE_VERSION (no leading 'v') to roll a newer LTS without a code change.
$script:DefaultNodeVersion = '22.11.0'

function Get-CtgNodeDist {
    <#
    .SYNOPSIS
        Describe the official nodejs.org portable build for a version/OS/arch: archive name, download
        URL, and where node/npm land inside the extracted folder (archive root on Windows, bin/ on
        Unix). Pure — every input is injectable so tests can pin each platform without mocking.
    #>
    [CmdletBinding()]
    param(
        [string]$Version = $(if ($env:IAM_RUNNER_NODE_VERSION) { $env:IAM_RUNNER_NODE_VERSION.TrimStart('v') } else { $script:DefaultNodeVersion }),
        [string]$Os      = $(if ($IsWindows) { 'win' } elseif ($IsMacOS) { 'darwin' } else { 'linux' }),
        [string]$Arch    = $(if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { 'arm64' } else { 'x64' })
    )
    $name = "node-v$Version-$Os-$Arch"
    $ext  = if ($Os -eq 'win') { '.zip' } else { '.tar.gz' }
    [pscustomobject]@{
        Name      = $name
        Archive   = "$name$ext"
        Url       = "https://nodejs.org/dist/v$Version/$name$ext"
        BinSubdir = $(if ($Os -eq 'win') { '' } else { 'bin' })
    }
}

function Install-CtgNodeRuntime {
    <#
    .SYNOPSIS
        Bootstrap a PORTABLE Node runtime into <runner>/.node when no system Node exists — the missing
        ingredient that kept the browser sidecar off hosts nobody wants to touch by hand (the central
        runner image, client DCs). Downloads the pinned official nodejs.org build, extracts it in
        place (Expand-Archive for the Windows zip, `tar -xzf` elsewhere), and prepends its bin dir to
        this process's PATH so npm/npx resolve immediately. No system install, no admin rights beyond
        writing the runner's own folder. Returns the resolved node path, or $null on any failure —
        never throws.
    #>
    [CmdletBinding()]
    param([int]$TimeoutSeconds = 600)
    try {
        $existing = Resolve-CtgNodeTool 'node'
        if ($existing) { return $existing }

        $dist = Get-CtgNodeDist
        $root = Get-CtgNodeInstallRoot
        New-Item -ItemType Directory -Force $root | Out-Null

        # A previous half-finished extract leaves the folder without its binary — wipe and redo.
        $target = Join-Path $root $dist.Name
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }

        Write-Host "browser sidecar: downloading portable Node $($dist.Name) from nodejs.org …" -ForegroundColor Yellow
        $archive = Join-Path $root $dist.Archive
        Invoke-WebRequest -Uri $dist.Url -OutFile $archive -UseBasicParsing -TimeoutSec $TimeoutSeconds
        try {
            if ($archive -like '*.zip') {
                Expand-Archive -LiteralPath $archive -DestinationPath $root -Force
            } else {
                # tar ships on every platform the runner supports (Windows 10+, macOS, Linux); the
                # official .tar.gz keeps the exec bits Expand-Archive would drop.
                $r = Invoke-CtgToolProcess -FilePath 'tar' -Arguments @('-xzf', $archive, '-C', $root) -TimeoutSeconds $TimeoutSeconds
                if ($r.Code -ne 0) { Write-Warning "browser sidecar: extracting Node failed ($($r.Code)): $($r.Tail)"; return $null }
            }
        } finally {
            Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        }

        $node = Resolve-CtgNodeTool 'node'   # finds the fresh install via Get-CtgLocalNodeDirs + prepends PATH
        if (-not $node) { Write-Warning "browser sidecar: Node extracted but its binary was not found under $target" }
        return $node
    } catch {
        Write-Warning "browser sidecar: portable Node install failed: $($_.Exception.Message)"
        return $null
    }
}

function Install-CtgBrowser {
    <#
    .SYNOPSIS
        One-time self-heal for the browser sidecar: when `node` is present but the Playwright harness
        (runner/browser/node_modules) or the Chromium binary is missing, install them — `npm install`
        in runner/browser, then `npx playwright install chromium`. With -BootstrapNode (the operator's
        remote "Install browser automation" directive), a missing Node is not a dead end: the portable
        runtime is downloaded into <runner>/.node first. Best-effort, bounded (each step has
        a timeout), logs progress. Returns $true only if Test-CtgBrowserAvailable is true afterwards.
        Never throws — a failed install just leaves the agent without the 'browser' capability.
    #>
    [CmdletBinding()]
    param([int]$TimeoutSeconds = 900, [switch]$BootstrapNode) # npm install + a cold Chromium download can take minutes
    try {
        if ($BootstrapNode -and -not (Resolve-CtgNodeTool 'node')) {
            if (-not (Install-CtgNodeRuntime)) { return $false }   # it already warned with the reason
        }
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

function ConvertFrom-CtgStageLine {
    <#
    .SYNOPSIS
        Extract the coarse setup-stage name from a sidecar stderr line, or $null if it isn't a marker.
    .DESCRIPTION
        The browser sidecar (run-flow.mjs reportStage) writes stage markers as a distinctly-prefixed
        stderr line: "[browser] @@stage:<name>". This pulls out <name> (signin|create|harvest|vault),
        ignoring any surrounding text. Pure/side-effect-free so it can be unit-tested in isolation.
        Returns $null for ordinary log lines so the caller only forwards real stage transitions.
    #>
    param([string]$Line)
    if ($Line -match '@@stage:([A-Za-z0-9_-]+)') { return $Matches[1] }
    return $null
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
        [int]$TimeoutSeconds = 180,
        # Optional live-progress hook: invoked with the coarse stage name (signin|create|harvest|…) each
        # time the sidecar emits a "@@stage:" marker on stderr, so a long browser run can advance a UI
        # checklist AS it works instead of only at the terminal result. Best-effort — a throwing hook is
        # swallowed. When omitted, stderr is still drained (for the error tail) but nothing is forwarded.
        [scriptblock]$OnStage
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
    $errSub = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.Write($spec)
        $proc.StandardInput.Close()
        # Drain stdout AND stderr concurrently: a synchronous ReadToEnd() on stdout would block, and if
        # Chromium fills the stderr pipe buffer (~64KB of GPU/sandbox noise) the child blocks writing
        # stderr → never closes stdout → the read never returns and the timeout can't fire.
        #
        # stdout: one async ReadToEnd (the result line is its LAST line — we only need the whole blob).
        # stderr: read LINE BY LINE as it arrives, so a "@@stage:" marker can be forwarded to $OnStage
        # WHILE the flow runs (not after exit). BeginErrorReadLine + an event handler enqueues each line
        # onto a thread-safe queue; the main thread below drains the queue, forwards stage markers, and
        # accumulates the lines for the error tail. This keeps both pipes emptying (no deadlock) while
        # the bounded wait loop can still time out a wedged child.
        $stderrLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
        $errSub = Register-ObjectEvent -InputObject $proc -EventName 'ErrorDataReceived' -MessageData $stderrLines -Action {
            if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue([string]$EventArgs.Data) }
        }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $proc.BeginErrorReadLine()

        $stderrSb = [System.Text.StringBuilder]::new()
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $timedOut = $false
        $drain = {
            $l = $null
            while ($stderrLines.TryDequeue([ref]$l)) {
                [void]$stderrSb.AppendLine($l)
                if ($OnStage) {
                    $stage = ConvertFrom-CtgStageLine $l
                    if ($stage) { try { & $OnStage $stage } catch { } } # forwarding is best-effort
                }
            }
        }
        while ($true) {
            & $drain
            if ($proc.HasExited) { break }
            if ([DateTime]::UtcNow -ge $deadline) { $timedOut = $true; break }
            Start-Sleep -Milliseconds 200
        }
        if ($timedOut) {
            try { $proc.Kill($true) } catch { }
            return [pscustomobject]@{ ok = $false; message = $null; error = "browser flow '$Flow' timed out after ${TimeoutSeconds}s"; evidence = $null; retryAfterMinutes = $null }
        }
        # Exited cleanly — make sure the async stderr pump has flushed, then drain any trailing lines.
        $proc.WaitForExit()
        & $drain
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $stderrSb.ToString()
    } catch {
        return [pscustomobject]@{ ok = $false; message = $null; error = "could not run the browser sidecar: $($_.Exception.Message)"; evidence = $null; retryAfterMinutes = $null }
    } finally {
        if ($errSub) { try { Unregister-Event -SubscriptionId $errSub.Id -ErrorAction SilentlyContinue; Remove-Job -Job $errSub -Force -ErrorAction SilentlyContinue } catch { } }
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
        # Harvested session from a browser-session (hybrid) connector's login flow (connector-login):
        # { cookies: {name:value}, token: string }. Present only for that flow; the caller registers
        # its values for redaction before using them. $null for every other flow.
        session           = if ($parsed.PSObject.Properties['session']) { $parsed.session } else { $null }
    }
}

Export-ModuleMember -Function Test-CtgBrowserAvailable, Install-CtgBrowser, Install-CtgNodeRuntime, Get-CtgNodeDist, Invoke-CtgBrowserFlow, Resolve-CtgNodeTool, ConvertFrom-CtgStageLine
