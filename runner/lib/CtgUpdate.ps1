# CtgUpdate.ps1 — the runner self-update PULL, factored out so it can run WITHOUT immediately
# relaunching the caller. Dot-sourced (like lib/CtgMigrate.ps1) by BOTH Start-IamRunner.ps1
# (Update-CtgRunner pulls then relaunches itself) and Start-IamRunnerPool.ps1 (the pool supervisor
# pulls ONCE for the whole pool, then converges its members — no thundering herd of N processes all
# pulling into one shared folder).
#
# Invoke-CtgManifestPull re-pulls every runner file from the app's manifest into $RunnerDir and prunes
# stragglers, exactly as the in-line Update-CtgRunner used to — but returns @{ buildId; count } instead
# of relaunching. The relaunch is the CALLER's decision (a single runner re-execs itself; the pool
# supervisor stops+respawns its members).

function Invoke-CtgManifestPull {
    param(
        [Parameter(Mandatory)][string]$AppUrl,
        [string]$ApiToken,
        [Parameter(Mandatory)][string]$RunnerDir
    )
    $H = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }
    Write-Host "self-update: pulling latest runner from $AppUrl" -ForegroundColor Yellow
    $manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H -TimeoutSec 30
    foreach ($rel in $manifest.files) {
        # Manifest paths are POSIX-style ('a/b/c'); Join-Path accepts '/' on Windows and it's native
        # on macOS/Linux, so use $rel as-is rather than forcing a backslash (which would corrupt
        # paths on a non-Windows central runner).
        $dest = Join-Path $RunnerDir $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        $resp = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H -TimeoutSec 60
        [System.IO.File]::WriteAllText($dest, $resp.Content)
    }
    # PRUNE files no longer in the bundle. Pulling-without-deleting leaves stale leftovers (a removed/
    # renamed module), and Get-CtgBuildId hashes EVERY file in the folder — so one leftover makes our
    # build id differ from the app's forever: "update available" that re-pulls but never converges
    # ("updated, back online… still the same version"). Keep only manifest files + the runtime files
    # the hash already excludes. NOTE the walk is deliberately WITHOUT -Force: on Unix that hides
    # dot-files (so the pool roster/locks are safe there), but on Windows Get-ChildItem returns them,
    # so the skip-list below MUST cover every runtime dot-file the pool adds — otherwise a Windows
    # self-update would delete .runner-pool.json (the roster) or a member's .runner.<id>.lock.
    $want = @{}; foreach ($rel in $manifest.files) { $want[(Join-Path $RunnerDir $rel)] = $true }
    foreach ($f in Get-ChildItem -LiteralPath $RunnerDir -Recurse -File -ErrorAction SilentlyContinue) {
        if ($want.ContainsKey($f.FullName)) { continue }
        # .build marker, ALL runner/pool lock files (.runner.lock, .runner.<agentId>.lock,
        # .runner-pool.lock), the pool roster (.runner-pool.json) + its update sentinel
        # (.runner-pool.update), macOS cruft, and logs — none ship in the bundle; never prune them.
        if ($f.Name -eq '.build' -or $f.Name -like '.runner*.lock' -or $f.Name -eq '.runner-pool.json' -or $f.Name -eq '.runner-pool.update' -or $f.Name -eq '.DS_Store' -or $f.Name -like '*.log') { continue }
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; Write-Host "self-update: pruned stale $($f.Name)" -ForegroundColor DarkYellow } catch { }
    }
    return @{ buildId = $manifest.buildId; count = @($manifest.files).Count }
}
