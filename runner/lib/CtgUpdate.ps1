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
    # renamed module), and Get-CtgBuildId hashes the folder — so one leftover makes our build id differ
    # from the app's forever: "update available" that re-pulls but never converges ("updated, back
    # online… still the same version").
    #
    # But prune ONLY within the file set the bundle could have shipped. Get-CtgBuildId (and the app's
    # bundle.ts) both SKIP tests/, dist/, node_modules/, scripts/ and every dot-segment, so a file in
    # one of those cannot move the build id and pruning it achieves nothing. It does do harm: the
    # browser sidecar's dependencies live in browser/node_modules and the portable Node in .node, and
    # neither is in the manifest — so this loop deleted @playwright/test on every self-update. The
    # agent then stopped reporting the 'browser' capability, the claim gate withheld every browser job
    # from every agent, and those jobs sat pending with no error and nobody able to run them. It was
    # reinstalled by hand twice and destroyed again both times (FR #0000121).
    #
    # -Force so the walk sees dot-entries on every platform (PowerShell hides them on Unix but not on
    # Windows); they are all skipped by the dot-segment rule below, so this only makes the two
    # platforms agree rather than widening what gets deleted.
    $skipDirs = 'tests', 'dist', 'node_modules', 'scripts'
    $want = @{}; foreach ($rel in $manifest.files) { $want[(Join-Path $RunnerDir $rel)] = $true }
    foreach ($f in Get-ChildItem -LiteralPath $RunnerDir -Recurse -File -Force -ErrorAction SilentlyContinue) {
        if ($want.ContainsKey($f.FullName)) { continue }
        $rel = ([System.IO.Path]::GetRelativePath($RunnerDir, $f.FullName)).Replace([char]92, [char]47)
        $excluded = $false
        foreach ($seg in $rel.Split('/')) {
            if ($skipDirs -contains $seg -or $seg.StartsWith('.')) { $excluded = $true; break }
        }
        # Outside the bundle's own file set — the build id never saw it, so leaving it costs nothing.
        # This covers .build, every .runner*.lock, .runner-pool.json/.update, .DS_Store and .node, all
        # of which used to need naming one by one.
        if ($excluded) { continue }
        if ($f.Name -like '*.Tests.ps1' -or $f.Name -like '*.log') { continue }
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; Write-Host "self-update: pruned stale $($f.Name)" -ForegroundColor DarkYellow } catch { }
    }
    return @{ buildId = $manifest.buildId; count = @($manifest.files).Count }
}
