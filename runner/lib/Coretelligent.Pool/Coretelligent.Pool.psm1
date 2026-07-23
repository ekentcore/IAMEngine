# Coretelligent.Pool — pure decision + persistence helpers for the runner POOL supervisor
# (Start-IamRunnerPool.ps1). Kept pure/unit-testable (as the codebase does with Get-CtgKeepAliveAction
# / Test-CtgStalled) so the crux logic — member identity + per-member lock naming + roster round-trip —
# is verified by Pester without spawning a single process.
#
# WHY a pool needs distinct identities: the app's atomic claim (runner-service.ts) load-balances across
# EQUAL-priority, SAME-scope peers keyed on agentId. N members with DISTINCT agentIds are admitted as
# concurrent peers and the queue splits across them race-safe (no web change). Two members sharing ONE
# agentId would both flip and read back the same assignedAgentId rows -> DOUBLE EXECUTION. So a distinct
# agentId per member is the correctness boundary, and this module is where that identity is resolved.

function Get-CtgPoolLockPath {
    # The single-instance lock path for ONE member, keyed by its agentId. MUST match the format
    # Start-IamRunner.ps1 writes (".runner.<agentId>.lock") — that agentId segment is exactly what lets
    # members coexist in one folder (each owns its own lock) instead of evicting each other via the old
    # per-folder .runner.lock. Two distinct ids -> two distinct paths; the same id -> the same path (so
    # newest-PID-wins eviction still fires within one member).
    param([Parameter(Mandatory)][string]$RunnerDir, [Parameter(Mandatory)][string]$AgentId)
    return (Join-Path $RunnerDir ".runner.$AgentId.lock")
}

function Get-CtgPoolMemberName {
    # Human label for a pooled agent on the Agents page: "<host> pool #<index>". Makes the pool legible
    # (N equal-priority peers of one scope) instead of N opaque ids.
    param([Parameter(Mandatory)][string]$HostName, [Parameter(Mandatory)][int]$Index)
    return "$HostName pool #$Index"
}

function Read-CtgPoolRoster {
    # Load the persisted roster ([{ index, agentId }, ...]) from disk. Fails SAFE: a missing or
    # unparseable file yields an empty array (the supervisor then lazy-enrolls from scratch) rather than
    # throwing — we never want a corrupt roster to wedge startup. Always returns an ARRAY.
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $raw = [System.IO.File]::ReadAllText($Path)
        if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
        return @($parsed | ForEach-Object { @{ index = [int]$_.index; agentId = [string]$_.agentId } } | Where-Object { $_.agentId })
    } catch { return @() }
}

function Write-CtgPoolRoster {
    # Persist the roster so member identities are STABLE across restarts (no orphaned Agent rows piling
    # up on every relaunch). Only members that actually HAVE an agentId are written; a not-yet-enrolled
    # slot is omitted so it's retried next start. Best-effort (never throws into the supervisor loop).
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Members)
    try {
        $rows = @($Members | Where-Object { $_.agentId } | ForEach-Object { [pscustomobject]@{ index = [int]$_.index; agentId = [string]$_.agentId } })
        # -AsArray so a single-member pool still serializes as a JSON array (round-trips through
        # Read-CtgPoolRoster's ForEach), not a bare object.
        [System.IO.File]::WriteAllText($Path, ($rows | ConvertTo-Json -Depth 4 -AsArray))
        return $true
    } catch { return $false }
}

function Resolve-CtgPoolMembers {
    # THE CRUX (pure). Given the requested pool size, the anchor agentId (member #0, the server-minted id
    # the installer already enrolled + passes in), and the persisted roster, produce the ordered member
    # list and mark WHICH need enrolling.
    #
    #   index 0        -> ALWAYS the anchor agentId, never enrolled (it already exists). Anchor wins over
    #                     any stale roster entry at index 0, so the id the operator installed is
    #                     authoritative.
    #   index 1..N-1   -> reuse the roster's agentId for that index if present (stable identity across
    #                     restarts); else needsEnroll=$true (the supervisor mints one via POST /api/agents
    #                     and persists it).
    #   N < roster     -> return only the first N; extras are dropped (NOT re-enrolled).
    #
    # Each member: @{ index; agentId (or $null when needs enrolling); needsEnroll }.
    param(
        [Parameter(Mandatory)][int]$PoolSize,
        [Parameter(Mandatory)][string]$AnchorAgentId,
        [AllowEmptyCollection()][object[]]$Roster = @()
    )
    if ($PoolSize -lt 1) { $PoolSize = 1 }
    # Index -> agentId from the roster (last write wins on a dup index; ignore blanks).
    $byIndex = @{}
    foreach ($r in $Roster) {
        if ($null -eq $r) { continue }
        $idx = [int]$r.index; $aid = [string]$r.agentId
        if ($aid) { $byIndex[$idx] = $aid }
    }
    $members = @()
    for ($i = 0; $i -lt $PoolSize; $i++) {
        if ($i -eq 0) {
            $members += @{ index = 0; agentId = $AnchorAgentId; needsEnroll = $false }
            continue
        }
        if ($byIndex.ContainsKey($i)) {
            $members += @{ index = $i; agentId = $byIndex[$i]; needsEnroll = $false }
        } else {
            $members += @{ index = $i; agentId = $null; needsEnroll = $true }
        }
    }
    return $members
}

Export-ModuleMember -Function Get-CtgPoolLockPath, Get-CtgPoolMemberName, Read-CtgPoolRoster, Write-CtgPoolRoster, Resolve-CtgPoolMembers
